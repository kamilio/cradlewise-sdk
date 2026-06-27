import {
  CognitoIdentityProviderClient,
  InitiateAuthCommand,
  RespondToAuthChallengeCommand,
  type AuthenticationResultType,
  type InitiateAuthCommandInput,
  type RespondToAuthChallengeCommandInput,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  CognitoIdentityClient,
  GetCredentialsForIdentityCommand,
  GetIdCommand,
} from "@aws-sdk/client-cognito-identity";
import {
  createSecretHash,
  createSrpSession,
  signSrpSession,
  wrapAuthChallenge,
  wrapInitiateAuth,
} from "cognito-srp-helper";
import { AppConfig } from "./config.js";
import { CradlewiseAuthError } from "./errors.js";
import { utf8ByteLength } from "./text-utils.js";
import type { CradlewiseCredentials, CradlewiseTokens } from "./types.js";

type SrpInitiateAuthRequest = Parameters<typeof wrapInitiateAuth>[1];
type SrpChallengeRequest = Parameters<typeof wrapAuthChallenge>[1];

const MAX_PASSWORD_BYTES = 4096;
const MAX_CREDENTIAL_BYTES = 128 * 1024;
const MAX_USERNAME_BYTES = 320;

export interface CradlewiseAuthOptions {
  email: string;
  password: string;
  appConfig: AppConfig;
  authenticationTimeoutMs?: number;
}

export class CradlewiseAuth {
  readonly email: string;
  readonly appConfig: AppConfig;
  readonly #password: string;
  readonly #authenticationTimeoutMs: number;
  #credentials: CradlewiseCredentials | undefined;
  #authentication: Promise<CradlewiseCredentials> | undefined;
  #authenticationAbort: AbortController | undefined;
  #authenticationGeneration = Symbol();

  constructor(options: CradlewiseAuthOptions) {
    if (
      typeof options !== "object" ||
      options === null ||
      Array.isArray(options)
    ) {
      throw new TypeError("options must be an object");
    }
    const email = options.email;
    const password = options.password;
    const appConfig = options.appConfig;
    const authenticationTimeoutMs = options.authenticationTimeoutMs ?? 30_000;
    if (
      typeof email !== "string" ||
      utf8ByteLength(email, 320) > 320 ||
      hasControlCharacter(email)
    ) {
      throw new TypeError(
        "email must be a nonempty string no longer than 320 bytes without controls",
      );
    }
    if (
      typeof password !== "string" ||
      password.length === 0 ||
      utf8ByteLength(password, MAX_PASSWORD_BYTES) > MAX_PASSWORD_BYTES
    ) {
      throw new TypeError(
        "password must be a nonempty string no longer than 4096 bytes",
      );
    }
    if (!(appConfig instanceof AppConfig)) {
      throw new TypeError("appConfig must be an AppConfig instance");
    }
    if (
      !Number.isSafeInteger(authenticationTimeoutMs) ||
      authenticationTimeoutMs <= 0 ||
      authenticationTimeoutMs > 2_147_483_647
    ) {
      throw new RangeError(
        "authenticationTimeoutMs must be a positive integer no greater than 2147483647",
      );
    }
    const normalizedEmail = email.trim();
    if (normalizedEmail.length === 0) {
      throw new TypeError("email must be a nonempty string");
    }
    this.email = normalizedEmail;
    this.#password = password;
    this.#authenticationTimeoutMs = authenticationTimeoutMs;
    this.appConfig = appConfig;
    makeReadonly(this, "email");
    makeReadonly(this, "appConfig");
  }

  get credentials(): CradlewiseCredentials | undefined {
    return this.#credentials ? cloneCredentials(this.#credentials) : undefined;
  }

  async authenticate(): Promise<CradlewiseCredentials> {
    const generation = this.#authenticationGeneration;
    if (!this.#authentication) {
      const abortController = new AbortController();
      const timeout = setTimeout(() => {
        const timeoutError = new Error("Cradlewise authentication timed out");
        timeoutError.name = "TimeoutError";
        abortController.abort(timeoutError);
      }, this.#authenticationTimeoutMs);
      const authentication = this.#performAuthentication(
        generation,
        abortController.signal,
      ).finally(() => {
        clearTimeout(timeout);
        if (this.#authentication === authentication) {
          this.#authentication = undefined;
        }
        if (this.#authenticationAbort === abortController) {
          this.#authenticationAbort = undefined;
        }
      });
      this.#authentication = authentication;
      this.#authenticationAbort = abortController;
    }
    const credentials = await this.#authentication;
    if (generation !== this.#authenticationGeneration) {
      throw new CradlewiseAuthError("Cradlewise authentication was superseded");
    }
    return cloneCredentials(credentials);
  }

  async ensureValid(
    minimumValidityMs = 60_000,
  ): Promise<CradlewiseCredentials> {
    if (
      !Number.isSafeInteger(minimumValidityMs) ||
      minimumValidityMs < 0 ||
      minimumValidityMs > 2_147_483_647
    ) {
      throw new RangeError(
        "minimumValidityMs must be a nonnegative integer no greater than 2147483647",
      );
    }
    const currentCredentials = this.#credentials;
    const expiration = currentCredentials?.aws.expiration.getTime() ?? 0;
    const tokenExpiration = currentCredentials?.tokens.expiresAt.getTime() ?? 0;
    if (
      currentCredentials &&
      Math.min(expiration, tokenExpiration) > Date.now() + minimumValidityMs
    ) {
      return cloneCredentials(currentCredentials);
    }
    const generation = this.#authenticationGeneration;
    const credentials = await this.authenticate();
    if (generation !== this.#authenticationGeneration) {
      throw new CradlewiseAuthError("Cradlewise authentication was superseded");
    }
    const refreshedExpiration = Math.min(
      credentials.aws.expiration.getTime(),
      credentials.tokens.expiresAt.getTime(),
    );
    if (refreshedExpiration <= Date.now() + minimumValidityMs) {
      if (generation === this.#authenticationGeneration) {
        this.#credentials = undefined;
      }
      throw new CradlewiseAuthError(
        "Cradlewise authentication returned credentials with insufficient remaining validity",
      );
    }
    return cloneCredentials(credentials);
  }

  clearCredentials(): void {
    this.#authenticationGeneration = Symbol();
    this.#authenticationAbort?.abort();
    this.#authenticationAbort = undefined;
    this.#credentials = undefined;
    this.#authentication = undefined;
  }

  async #performAuthentication(
    generation: symbol,
    abortSignal: AbortSignal,
  ): Promise<CradlewiseCredentials> {
    const config = this.appConfig;
    let provider: CognitoIdentityProviderClient | undefined;
    let identity: CognitoIdentityClient | undefined;
    try {
      provider = new CognitoIdentityProviderClient({
        region: config.cognitoRegion,
      });
      const secretHash = createSecretHash(
        this.email,
        config.cognitoAppClientId,
        config.cognitoAppClientSecret,
      );
      const session = createSrpSession(
        this.email,
        this.#password,
        config.cognitoUserPoolId,
        false,
      );
      const initiateInput: InitiateAuthCommandInput = {
        AuthFlow: "USER_SRP_AUTH",
        ClientId: config.cognitoAppClientId,
        AuthParameters: {
          CHALLENGE_NAME: "SRP_A",
          SECRET_HASH: secretHash,
          USERNAME: this.email,
        },
      };
      const initiated = await raceWithAbort(
        provider.send(
          new InitiateAuthCommand(
            wrapInitiateAuth(
              session,
              initiateInput as unknown as SrpInitiateAuthRequest,
            ) as InitiateAuthCommandInput,
          ),
          { abortSignal },
        ),
        abortSignal,
      );

      const challengeName = initiated.ChallengeName;
      const challengeSession = initiated.Session;
      if (challengeName !== "PASSWORD_VERIFIER") {
        throw new Error(
          `Unsupported Cognito challenge: ${challengeName ?? "none"}`,
        );
      }
      if (
        challengeSession !== undefined &&
        !isCredentialString(challengeSession)
      ) {
        throw new Error("Cognito returned an invalid challenge session");
      }
      const challengeParameters = snapshotChallengeParameters(
        initiated.ChallengeParameters,
      );

      const signedSession = signSrpSession(session, {
        ChallengeName: challengeName,
        ChallengeParameters: challengeParameters,
        ...(challengeSession ? { Session: challengeSession } : {}),
      });
      const challengeUsernameValue = challengeParameters.USER_ID_FOR_SRP;
      let challengeUsername = this.email;
      if (challengeUsernameValue !== undefined) {
        if (
          typeof challengeUsernameValue !== "string" ||
          utf8ByteLength(challengeUsernameValue, MAX_USERNAME_BYTES) >
            MAX_USERNAME_BYTES ||
          hasControlCharacter(challengeUsernameValue)
        ) {
          throw new Error("Cognito returned an invalid challenge username");
        }
        const normalizedChallengeUsername = challengeUsernameValue.trim();
        if (normalizedChallengeUsername.length === 0) {
          throw new Error("Cognito returned an invalid challenge username");
        }
        challengeUsername = normalizedChallengeUsername;
      }
      const challengeSecretHash = createSecretHash(
        challengeUsername,
        config.cognitoAppClientId,
        config.cognitoAppClientSecret,
      );
      const challengeInput: RespondToAuthChallengeCommandInput = {
        ChallengeName: "PASSWORD_VERIFIER",
        ClientId: config.cognitoAppClientId,
        ...(challengeSession ? { Session: challengeSession } : {}),
        ChallengeResponses: {
          SECRET_HASH: challengeSecretHash,
          USERNAME: challengeUsername,
        },
      };
      const challenge = await raceWithAbort(
        provider.send(
          new RespondToAuthChallengeCommand(
            wrapAuthChallenge(
              signedSession,
              challengeInput as unknown as SrpChallengeRequest,
            ) as RespondToAuthChallengeCommandInput,
          ),
          { abortSignal },
        ),
        abortSignal,
      );

      const nextChallengeName = challenge.ChallengeName;
      const authenticationResult = challenge.AuthenticationResult;
      if (nextChallengeName) {
        throw new Error(`Unsupported Cognito challenge: ${nextChallengeName}`);
      }

      const tokens = parseTokens(authenticationResult);
      identity = new CognitoIdentityClient({
        region: config.cognitoRegion,
      });
      const providerName = `cognito-idp.${config.cognitoRegion}.amazonaws.com/${config.cognitoUserPoolId}`;
      const logins = { [providerName]: tokens.idToken };
      const identityResult = await raceWithAbort(
        identity.send(
          new GetIdCommand({
            IdentityPoolId: config.cognitoIdentityPoolId,
            Logins: logins,
          }),
          { abortSignal },
        ),
        abortSignal,
      );
      const identityIdValue = identityResult.IdentityId;
      if (typeof identityIdValue !== "string")
        throw new Error("Cognito did not return an identity ID");
      if (
        utf8ByteLength(identityIdValue, MAX_CREDENTIAL_BYTES) >
        MAX_CREDENTIAL_BYTES
      ) {
        throw new Error("Cognito did not return an identity ID");
      }
      const identityId = identityIdValue.trim();
      if (!isCredentialString(identityId)) {
        throw new Error("Cognito did not return an identity ID");
      }

      const credentialsResult = await raceWithAbort(
        identity.send(
          new GetCredentialsForIdentityCommand({
            IdentityId: identityId,
            Logins: logins,
          }),
          { abortSignal },
        ),
        abortSignal,
      );
      const aws = credentialsResult.Credentials;
      const accessKeyId = aws?.AccessKeyId;
      const secretAccessKey = aws?.SecretKey;
      const sessionToken = aws?.SessionToken;
      const expiration = aws?.Expiration;
      const expirationTime =
        expiration instanceof Date
          ? Date.prototype.getTime.call(expiration)
          : Number.NaN;
      if (
        !isCredentialString(accessKeyId) ||
        !isCredentialString(secretAccessKey) ||
        !isCredentialString(sessionToken) ||
        !Number.isFinite(expirationTime) ||
        expirationTime <= Date.now()
      ) {
        throw new Error("Cognito did not return complete AWS credentials");
      }

      if (generation !== this.#authenticationGeneration) {
        throw new Error("Cradlewise authentication was superseded");
      }
      this.#credentials = {
        tokens,
        identityId,
        aws: {
          accessKeyId,
          secretAccessKey,
          sessionToken,
          expiration: new Date(expirationTime),
        },
      };
      return this.#credentials;
    } catch (error) {
      if (generation === this.#authenticationGeneration) {
        this.#credentials = undefined;
      }
      throw new CradlewiseAuthError("Cradlewise authentication failed", {
        cause: error,
      });
    } finally {
      safelyDestroy(identity);
      safelyDestroy(provider);
    }
  }
}

function makeReadonly<T extends object, K extends keyof T>(
  target: T,
  key: K,
): void {
  Object.defineProperty(target, key, {
    configurable: false,
    enumerable: true,
    writable: false,
  });
}

function safelyDestroy(client: { destroy(): void } | undefined): void {
  if (!client) return;
  try {
    client.destroy();
  } catch {
    return;
  }
}

function raceWithAbort<T>(
  operation: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", handleAbort);
      callback();
    };
    const handleAbort = () => finish(() => reject(abortReason(signal)));
    signal.addEventListener("abort", handleAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(() => resolve(value)),
      (error: unknown) => finish(() => reject(asError(error))),
    );
  });
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error("The operation was aborted", { cause: signal.reason });
}

function asError(value: unknown): Error {
  return value instanceof Error
    ? value
    : new Error("The operation failed", { cause: value });
}

function parseTokens(
  result: AuthenticationResultType | undefined,
): CradlewiseTokens {
  const accessToken = result?.AccessToken;
  const idToken = result?.IdToken;
  const refreshToken = result?.RefreshToken;
  const reportedExpiresIn = result?.ExpiresIn;
  if (!isCredentialString(accessToken) || !isCredentialString(idToken)) {
    throw new Error("Cognito did not return access and ID tokens");
  }
  const idTokenExpiration = readJwtExpiration(idToken);
  const accessTokenExpiration = readJwtExpiration(accessToken);
  const expiresIn =
    typeof reportedExpiresIn === "number" &&
    Number.isFinite(reportedExpiresIn) &&
    reportedExpiresIn > 0
      ? reportedExpiresIn
      : 3600;
  const now = Date.now();
  if (accessTokenExpiration && accessTokenExpiration.getTime() <= now) {
    throw new Error("Cognito returned an expired access token");
  }
  if (idTokenExpiration && idTokenExpiration.getTime() <= now) {
    throw new Error("Cognito returned an expired ID token");
  }
  const reportedExpiration = new Date(now + expiresIn * 1000);
  const expiresAt = new Date(
    Math.min(
      idTokenExpiration?.getTime() ?? reportedExpiration.getTime(),
      accessTokenExpiration?.getTime() ?? Number.POSITIVE_INFINITY,
      reportedExpiration.getTime(),
    ),
  );
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now) {
    throw new Error("Cognito returned an expired ID token");
  }
  return {
    accessToken,
    idToken,
    expiresAt,
    ...(isCredentialString(refreshToken) ? { refreshToken } : {}),
  };
}

function snapshotChallengeParameters(
  value: Record<string, string> | undefined,
): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Cognito returned invalid challenge parameters");
  }
  const snapshot: Record<string, string> = {};
  let totalBytes = 0;
  let entries = 0;
  for (const key in value) {
    if (!Object.hasOwn(value, key)) continue;
    entries += 1;
    if (entries > 32) {
      throw new Error("Cognito returned invalid challenge parameters");
    }
    const entry: unknown = value[key];
    if (
      key.length === 0 ||
      hasControlCharacter(key) ||
      (key === "USER_ID_FOR_SRP"
        ? typeof entry !== "string" ||
          entry.length === 0 ||
          utf8ByteLength(entry, MAX_CREDENTIAL_BYTES) > MAX_CREDENTIAL_BYTES
        : !isCredentialString(entry))
    ) {
      throw new Error("Cognito returned invalid challenge parameters");
    }
    const safeEntry = entry as string;
    totalBytes +=
      utf8ByteLength(key, MAX_CREDENTIAL_BYTES) +
      utf8ByteLength(safeEntry, MAX_CREDENTIAL_BYTES);
    if (totalBytes > MAX_CREDENTIAL_BYTES) {
      throw new Error("Cognito returned invalid challenge parameters");
    }
    snapshot[key] = safeEntry;
  }
  return snapshot;
}

function isCredentialString(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    utf8ByteLength(value, MAX_CREDENTIAL_BYTES) <= MAX_CREDENTIAL_BYTES &&
    value === value.trim() &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function cloneCredentials(
  credentials: CradlewiseCredentials,
): CradlewiseCredentials {
  return {
    identityId: credentials.identityId,
    tokens: {
      accessToken: credentials.tokens.accessToken,
      idToken: credentials.tokens.idToken,
      expiresAt: new Date(credentials.tokens.expiresAt),
      ...(credentials.tokens.refreshToken
        ? { refreshToken: credentials.tokens.refreshToken }
        : {}),
    },
    aws: {
      accessKeyId: credentials.aws.accessKeyId,
      secretAccessKey: credentials.aws.secretAccessKey,
      sessionToken: credentials.aws.sessionToken,
      expiration: new Date(credentials.aws.expiration),
    },
  };
}

function readJwtExpiration(token: string): Date | undefined {
  try {
    const encodedPayload = token.split(".")[1];
    if (!encodedPayload) return undefined;
    const payload: unknown = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    );
    if (!payload || typeof payload !== "object") return undefined;
    const expiration: unknown = Reflect.get(payload, "exp");
    if (
      typeof expiration !== "number" ||
      !Number.isFinite(expiration) ||
      expiration <= 0
    ) {
      return undefined;
    }
    const date = new Date(expiration * 1000);
    return Number.isFinite(date.getTime()) ? date : undefined;
  } catch {
    return undefined;
  }
}
