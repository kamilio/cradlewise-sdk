import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  providerSend: vi.fn(),
  identitySend: vi.fn(),
  providerDestroy: vi.fn(),
  identityDestroy: vi.fn(),
  createSecretHash: vi.fn((username: string) => `hash:${username}`),
  createSrpSession: vi.fn(() => ({ session: true })),
  signSrpSession: vi.fn(() => ({ signed: true })),
  wrapInitiateAuth: vi.fn((_session: unknown, input: unknown) => input),
  wrapAuthChallenge: vi.fn((_session: unknown, input: unknown) => input),
}));

vi.mock("@aws-sdk/client-cognito-identity-provider", () => ({
  CognitoIdentityProviderClient: class {
    send = mocks.providerSend;
    destroy = mocks.providerDestroy;
  },
  InitiateAuthCommand: class {
    constructor(readonly input: unknown) {}
  },
  RespondToAuthChallengeCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

vi.mock("@aws-sdk/client-cognito-identity", () => ({
  CognitoIdentityClient: class {
    send = mocks.identitySend;
    destroy = mocks.identityDestroy;
  },
  GetIdCommand: class {
    constructor(readonly input: unknown) {}
  },
  GetCredentialsForIdentityCommand: class {
    constructor(readonly input: unknown) {}
  },
}));

vi.mock("cognito-srp-helper", () => ({
  createSecretHash: mocks.createSecretHash,
  createSrpSession: mocks.createSrpSession,
  signSrpSession: mocks.signSrpSession,
  wrapInitiateAuth: mocks.wrapInitiateAuth,
  wrapAuthChallenge: mocks.wrapAuthChallenge,
}));

import { CradlewiseAuth } from "../src/auth.js";
import { AppConfig } from "../src/config.js";

const appConfig = new AppConfig({
  cognitoUserPoolId: "us-east-1_pool",
  cognitoAppClientId: "client",
  cognitoAppClientSecret: "secret",
  cognitoIdentityPoolId: "identity-pool",
  cognitoRegion: "us-east-1",
  apiBaseUrl: "https://backend.cradlewise.com",
});

function jwt(exp: number): string {
  return `header.${Buffer.from(JSON.stringify({ exp })).toString("base64url")}.signature`;
}

describe("CradlewiseAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.providerSend.mockReset();
    mocks.identitySend.mockReset();
    mocks.providerSend
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
        Session: "session",
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: "access",
          IdToken: jwt(2_000_000_000),
          RefreshToken: "refresh",
          ExpiresIn: 3600,
        },
      });
    mocks.identitySend
      .mockResolvedValueOnce({ IdentityId: "identity-id" })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "key",
          SecretKey: "secret",
          SessionToken: "token",
          Expiration: new Date("2030-01-01T00:00:00Z"),
        },
      });
  });

  it("validates and normalizes constructor credentials", () => {
    expect(() => new CradlewiseAuth(null as never)).toThrow(
      "options must be an object",
    );
    expect(
      () => new CradlewiseAuth({ email: " ", password: "password", appConfig }),
    ).toThrow(TypeError);
    expect(
      () =>
        new CradlewiseAuth({
          email: "parent@example.com",
          password: "",
          appConfig,
        }),
    ).toThrow(TypeError);
    expect(
      () =>
        new CradlewiseAuth({
          email: "parent@example.com",
          password: "x".repeat(4097),
          appConfig,
        }),
    ).toThrow("4096 bytes");
    expect(
      () =>
        new CradlewiseAuth({
          email: "parent@example.com\nignored",
          password: "password",
          appConfig,
        }),
    ).toThrow("without controls");
    expect(
      () =>
        new CradlewiseAuth({
          email: `${"a".repeat(309)}@example.com`,
          password: "password",
          appConfig,
        }),
    ).toThrow("320 bytes");
    expect(
      () =>
        new CradlewiseAuth({
          email: "parent@example.com\u0085ignored",
          password: "password",
          appConfig,
        }),
    ).toThrow("without controls");
    expect(
      () =>
        new CradlewiseAuth({
          email: "parent@example.com",
          password: "password",
          appConfig: {} as never,
        }),
    ).toThrow("AppConfig instance");
    expect(
      () =>
        new CradlewiseAuth({
          email: "parent@example.com",
          password: "password",
          appConfig,
          authenticationTimeoutMs: 0,
        }),
    ).toThrow("authenticationTimeoutMs");
    const auth = new CradlewiseAuth({
      email: " parent@example.com ",
      password: "password",
      appConfig,
    });
    expect(auth.email).toBe("parent@example.com");
    expect(Reflect.set(auth, "appConfig", {})).toBe(false);
    expect(auth.appConfig).toBe(appConfig);
  });

  it("snapshots constructor option getters once", () => {
    const reads = new Map<string, number>();
    const options = {} as Record<string, unknown>;
    for (const [key, value] of Object.entries({
      email: " parent@example.com ",
      password: "password",
      appConfig,
      authenticationTimeoutMs: 1234,
    })) {
      Object.defineProperty(options, key, {
        enumerable: true,
        get: () => {
          reads.set(key, (reads.get(key) ?? 0) + 1);
          return value;
        },
      });
    }

    const auth = new CradlewiseAuth(options as never);

    expect(auth.email).toBe("parent@example.com");
    expect(auth.appConfig).toBe(appConfig);
    expect(Object.fromEntries(reads)).toEqual({
      email: 1,
      password: 1,
      appConfig: 1,
      authenticationTimeoutMs: 1,
    });
  });

  it("performs SRP and exchanges tokens for AWS credentials", async () => {
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    const [credentials, concurrentCredentials] = await Promise.all([
      auth.authenticate(),
      auth.authenticate(),
    ]);

    expect(credentials.identityId).toBe("identity-id");
    expect(concurrentCredentials).not.toBe(credentials);
    expect(concurrentCredentials).toStrictEqual(credentials);
    expect(credentials.tokens.refreshToken).toBe("refresh");
    expect(credentials.aws.accessKeyId).toBe("key");
    expect(mocks.createSecretHash).toHaveBeenNthCalledWith(
      2,
      "canonical-user",
      "client",
      "secret",
    );
    expect(auth.credentials).not.toBe(credentials);
    expect(auth.credentials).toStrictEqual(credentials);
    await expect(auth.ensureValid()).resolves.toStrictEqual(credentials);
    expect(mocks.providerSend).toHaveBeenCalledTimes(2);
    expect(mocks.providerDestroy).toHaveBeenCalledOnce();
    expect(mocks.identityDestroy).toHaveBeenCalledOnce();
    const providerSignal = mocks.providerSend.mock.calls[0]?.[1]?.abortSignal;
    const identitySignal = mocks.identitySend.mock.calls[0]?.[1]?.abortSignal;
    expect(providerSignal).toBeInstanceOf(AbortSignal);
    expect(identitySignal).toBe(providerSignal);

    credentials.aws.expiration.setTime(0);
    credentials.tokens.expiresAt.setTime(0);
    expect((await auth.ensureValid()).aws.accessKeyId).toBe("key");
    expect(mocks.providerSend).toHaveBeenCalledTimes(2);
    auth.clearCredentials();
    expect(auth.credentials).toBeUndefined();
  });

  it("snapshots authentication result and AWS credential fields once", async () => {
    const reads = new Map<string, number>();
    const readOnce = <T>(key: string, value: T) => ({
      enumerable: true,
      get: () => {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return value;
      },
    });
    const authenticationResult = {};
    Object.defineProperties(authenticationResult, {
      AccessToken: readOnce("AccessToken", "access"),
      IdToken: readOnce("IdToken", jwt(2_000_000_000)),
      RefreshToken: readOnce("RefreshToken", "refresh"),
      ExpiresIn: readOnce("ExpiresIn", 3600),
    });
    const sourceExpiration = new Date("2030-01-01T00:00:00Z");
    const awsCredentials = {};
    Object.defineProperties(awsCredentials, {
      AccessKeyId: readOnce("AccessKeyId", "key"),
      SecretKey: readOnce("SecretKey", "secret"),
      SessionToken: readOnce("SessionToken", "token"),
      Expiration: readOnce("Expiration", sourceExpiration),
    });
    mocks.providerSend
      .mockReset()
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({ AuthenticationResult: authenticationResult });
    mocks.identitySend
      .mockReset()
      .mockResolvedValueOnce({ IdentityId: "identity-id" })
      .mockResolvedValueOnce({ Credentials: awsCredentials });

    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    const credentials = await auth.authenticate();
    sourceExpiration.setTime(0);

    expect(Object.fromEntries(reads)).toEqual({
      AccessToken: 1,
      IdToken: 1,
      RefreshToken: 1,
      ExpiresIn: 1,
      AccessKeyId: 1,
      SecretKey: 1,
      SessionToken: 1,
      Expiration: 1,
    });
    expect(credentials.aws.expiration.toISOString()).toBe(
      "2030-01-01T00:00:00.000Z",
    );
  });

  it("snapshots the Cognito identity ID once", async () => {
    let identityReads = 0;
    const identityResult = {};
    Object.defineProperty(identityResult, "IdentityId", {
      enumerable: true,
      get: () => {
        identityReads += 1;
        return identityReads === 1 ? "identity-id" : "changed-id";
      },
    });
    mocks.identitySend
      .mockReset()
      .mockResolvedValueOnce(identityResult)
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "key",
          SecretKey: "secret",
          SessionToken: "token",
          Expiration: new Date("2030-01-01T00:00:00Z"),
        },
      });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });

    await expect(auth.authenticate()).resolves.toMatchObject({
      identityId: "identity-id",
    });
    expect(identityReads).toBe(1);
  });

  it("rejects oversized aggregate challenge parameters", async () => {
    mocks.providerSend.mockReset().mockResolvedValueOnce({
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: Object.fromEntries(
        Array.from({ length: 33 }, (_, index) => [`field${index}`, "value"]),
      ),
    });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });

    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito returned invalid challenge parameters",
      }),
    });
  });

  it("rejects invalid credential validity windows", async () => {
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.ensureValid(-1)).rejects.toThrow(RangeError);
    await expect(auth.ensureValid(Number.NaN)).rejects.toThrow(RangeError);
    await expect(auth.ensureValid(1.5)).rejects.toThrow(RangeError);
    await expect(auth.ensureValid(2_147_483_648)).rejects.toThrow(RangeError);
    expect(mocks.providerSend).not.toHaveBeenCalled();
  });

  it("aborts a stalled authentication and still destroys the SDK client", async () => {
    mocks.providerSend.mockReset().mockImplementation((_command, options) => {
      const signal = options?.abortSignal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        if (!signal) return reject(new Error("missing abort signal"));
        const abort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("authentication aborted"),
          );
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
      authenticationTimeoutMs: 1,
    });

    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
    });
    expect(mocks.providerDestroy).toHaveBeenCalledOnce();
    expect(mocks.identityDestroy).not.toHaveBeenCalled();
  });

  it("enforces authentication timeout when the SDK ignores abort signals", async () => {
    mocks.providerSend
      .mockReset()
      .mockImplementation(() => new Promise(() => undefined));
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
      authenticationTimeoutMs: 20,
    });

    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({ name: "TimeoutError" }),
    });
    expect(mocks.providerDestroy).toHaveBeenCalledOnce();
    expect(mocks.identityDestroy).not.toHaveBeenCalled();

    mocks.providerSend
      .mockReset()
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: "access",
          IdToken: jwt(2_000_000_000),
        },
      });
    await expect(auth.authenticate()).resolves.toMatchObject({
      identityId: "identity-id",
    });
  });

  it("aborts in-flight authentication when credentials are cleared", async () => {
    mocks.providerSend.mockReset().mockImplementation((_command, options) => {
      const signal = options?.abortSignal as AbortSignal | undefined;
      return new Promise((_resolve, reject) => {
        if (!signal) return reject(new Error("missing abort signal"));
        const abort = () => reject(new Error("authentication aborted"));
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
      authenticationTimeoutMs: 60_000,
    });

    const authentication = auth.authenticate();
    await vi.waitFor(() => expect(mocks.providerSend).toHaveBeenCalledOnce());
    const signal = mocks.providerSend.mock.calls[0]?.[1]?.abortSignal as
      AbortSignal | undefined;
    auth.clearCredentials();

    expect(signal?.aborted).toBe(true);
    await expect(authentication).rejects.toMatchObject({
      name: "CradlewiseAuthError",
    });
    expect(mocks.providerDestroy).toHaveBeenCalledOnce();
    expect(auth.credentials).toBeUndefined();
  });

  it("rejects freshly issued credentials below the requested validity", async () => {
    mocks.identitySend
      .mockReset()
      .mockResolvedValueOnce({ IdentityId: "identity-id" })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "key",
          SecretKey: "secret",
          SessionToken: "token",
          Expiration: new Date(Date.now() + 30_000),
        },
      });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.ensureValid(60_000)).rejects.toThrow(
      "insufficient remaining validity",
    );
    expect(auth.credentials).toBeUndefined();
  });

  it("reauthenticates after temporary AWS credentials expire", async () => {
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    const initial = await auth.authenticate();
    mocks.providerSend
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
        Session: "session-2",
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: "access-2",
          IdToken: jwt(2_000_000_100),
        },
      });
    mocks.identitySend
      .mockResolvedValueOnce({ IdentityId: "identity-id-2" })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "key-2",
          SecretKey: "secret-2",
          SessionToken: "token-2",
          Expiration: new Date("2030-01-02T00:00:00Z"),
        },
      });

    const now = vi
      .spyOn(Date, "now")
      .mockReturnValue(new Date("2030-01-01T00:00:01Z").getTime());
    try {
      const refreshed = await auth.ensureValid();
      expect(refreshed).not.toBe(initial);
      expect(refreshed.identityId).toBe("identity-id-2");
      expect(refreshed.aws.accessKeyId).toBe("key-2");
    } finally {
      now.mockRestore();
    }
  });

  it("allows authentication to be retried after a transient failure", async () => {
    mocks.providerSend.mockReset().mockRejectedValueOnce(new Error("network"));
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
    });

    mocks.providerSend
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: "access",
          IdToken: jwt(2_000_000_000),
        },
      });
    await expect(auth.authenticate()).resolves.toMatchObject({
      identityId: "identity-id",
    });
  });

  it("does not let a cleared in-flight login overwrite newer credentials", async () => {
    let resolveOldLogin!: (value: unknown) => void;
    const oldLogin = new Promise((resolve) => {
      resolveOldLogin = resolve;
    });
    mocks.providerSend.mockReset().mockReturnValueOnce(oldLogin);
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    const superseded = auth.authenticate();
    auth.clearCredentials();

    mocks.providerSend
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: "new-access",
          IdToken: jwt(2_000_000_000),
        },
      });
    const current = await auth.authenticate();
    resolveOldLogin({ ChallengeName: "SMS_MFA" });

    await expect(superseded).rejects.toMatchObject({
      name: "CradlewiseAuthError",
    });
    expect(auth.credentials).toStrictEqual(current);
  });

  it("does not return credentials cleared after a shared login resolves", async () => {
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    const clearingLogin = auth.authenticate().then((credentials) => {
      auth.clearCredentials();
      return credentials;
    });
    const validity = auth.ensureValid();

    await clearingLogin;
    await expect(validity).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      message: "Cradlewise authentication was superseded",
    });
    expect(auth.credentials).toBeUndefined();
  });

  it("wraps unsupported challenges as authentication errors", async () => {
    mocks.providerSend
      .mockReset()
      .mockResolvedValue({ ChallengeName: "SMS_MFA" });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
    });
    expect(mocks.providerDestroy).toHaveBeenCalledOnce();
    expect(mocks.identityDestroy).not.toHaveBeenCalled();
  });

  it("rejects malformed challenge usernames", async () => {
    mocks.providerSend.mockReset().mockResolvedValueOnce({
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: { USER_ID_FOR_SRP: "canonical\nuser" },
    });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito returned an invalid challenge username",
      }),
    });

    mocks.providerSend.mockReset().mockResolvedValueOnce({
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: { USER_ID_FOR_SRP: "x".repeat(321) },
    });
    await expect(
      new CradlewiseAuth({
        email: "parent@example.com",
        password: "password",
        appConfig,
      }).authenticate(),
    ).rejects.toMatchObject({
      cause: expect.objectContaining({
        message: "Cognito returned an invalid challenge username",
      }),
    });
  });

  it("rejects malformed challenge sessions", async () => {
    mocks.providerSend.mockReset().mockResolvedValueOnce({
      ChallengeName: "PASSWORD_VERIFIER",
      ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      Session: " ",
    });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });

    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito returned an invalid challenge session",
      }),
    });
    expect(mocks.providerSend).toHaveBeenCalledOnce();
  });

  it("rejects incomplete token responses", async () => {
    mocks.providerSend
      .mockReset()
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({ AuthenticationResult: { AccessToken: "only" } });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito did not return access and ID tokens",
      }),
    });
    expect(mocks.identitySend).not.toHaveBeenCalled();
  });

  it("rejects expired ID tokens before requesting AWS credentials", async () => {
    mocks.providerSend
      .mockReset()
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: "access",
          IdToken: jwt(1),
          ExpiresIn: 3600,
        },
      });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito returned an expired ID token",
      }),
    });
    expect(mocks.identitySend).not.toHaveBeenCalled();
  });

  it("rejects expired access tokens before requesting AWS credentials", async () => {
    mocks.providerSend
      .mockReset()
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: jwt(1),
          IdToken: jwt(2_000_000_000),
          ExpiresIn: 3600,
        },
      });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito returned an expired access token",
      }),
    });
    expect(mocks.identitySend).not.toHaveBeenCalled();
  });

  it("uses the earliest verifiable Cognito token expiration", async () => {
    const nowSeconds = 1_800_000_000;
    const now = vi.spyOn(Date, "now").mockReturnValue(nowSeconds * 1000);
    mocks.providerSend
      .mockReset()
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: jwt(nowSeconds + 120),
          IdToken: jwt(nowSeconds + 3600),
          ExpiresIn: 3600,
        },
      });
    try {
      const auth = new CradlewiseAuth({
        email: "parent@example.com",
        password: "password",
        appConfig,
      });
      const credentials = await auth.authenticate();
      expect(credentials.tokens.expiresAt.getTime()).toBe(
        (nowSeconds + 120) * 1000,
      );
    } finally {
      now.mockRestore();
    }
  });

  it("rejects missing identity IDs", async () => {
    mocks.identitySend.mockReset().mockResolvedValueOnce({});
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito did not return an identity ID",
      }),
    });
  });

  it("rejects incomplete temporary AWS credentials", async () => {
    mocks.identitySend
      .mockReset()
      .mockResolvedValueOnce({ IdentityId: "identity-id" })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "key",
          SecretKey: "secret",
          Expiration: new Date("2030-01-01T00:00:00Z"),
        },
      });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito did not return complete AWS credentials",
      }),
    });
  });

  it("rejects whitespace-padded token and credential strings", async () => {
    mocks.providerSend
      .mockReset()
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: " access",
          IdToken: jwt(2_000_000_000),
        },
      });
    const tokenAuth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(tokenAuth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito did not return access and ID tokens",
      }),
    });

    mocks.providerSend
      .mockReset()
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: "access",
          IdToken: jwt(2_000_000_000),
        },
      });
    mocks.identitySend
      .mockReset()
      .mockResolvedValueOnce({ IdentityId: " identity-id " })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: " key",
          SecretKey: "secret",
          SessionToken: "token",
          Expiration: new Date("2030-01-01T00:00:00Z"),
        },
      });
    const credentialAuth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(credentialAuth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito did not return complete AWS credentials",
      }),
    });
    expect(mocks.identitySend.mock.calls[1]?.[0].input.IdentityId).toBe(
      "identity-id",
    );
  });

  it("falls back from malformed JWT expiry claims", async () => {
    const malformedJwt = `header.${Buffer.from(
      JSON.stringify({ exp: "not-a-number" }),
    ).toString("base64url")}.signature`;
    mocks.providerSend.mockReset();
    mocks.providerSend
      .mockResolvedValueOnce({
        ChallengeName: "PASSWORD_VERIFIER",
        ChallengeParameters: { USER_ID_FOR_SRP: "canonical-user" },
      })
      .mockResolvedValueOnce({
        AuthenticationResult: {
          AccessToken: "access",
          IdToken: malformedJwt,
          ExpiresIn: 120,
        },
      });
    const before = Date.now();
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    const credentials = await auth.authenticate();
    expect(credentials.tokens.expiresAt.getTime()).toBeGreaterThanOrEqual(
      before + 120_000,
    );
    expect(credentials.tokens.expiresAt.getTime()).toBeLessThanOrEqual(
      Date.now() + 120_000,
    );
  });

  it("rejects invalid temporary credential expiration dates", async () => {
    mocks.identitySend
      .mockReset()
      .mockResolvedValueOnce({ IdentityId: "identity-id" })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "key",
          SecretKey: "secret",
          SessionToken: "token",
          Expiration: new Date(Number.NaN),
        },
      });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito did not return complete AWS credentials",
      }),
    });
  });

  it("rejects expired temporary AWS credentials", async () => {
    mocks.identitySend
      .mockReset()
      .mockResolvedValueOnce({ IdentityId: "identity-id" })
      .mockResolvedValueOnce({
        Credentials: {
          AccessKeyId: "key",
          SecretKey: "secret",
          SessionToken: "token",
          Expiration: new Date(0),
        },
      });
    const auth = new CradlewiseAuth({
      email: "parent@example.com",
      password: "password",
      appConfig,
    });
    await expect(auth.authenticate()).rejects.toMatchObject({
      name: "CradlewiseAuthError",
      cause: expect.objectContaining({
        message: "Cognito did not return complete AWS credentials",
      }),
    });
  });
});
