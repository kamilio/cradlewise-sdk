import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { networkInterfaces } from "node:os";

export const OAUTH_FLAG = "--oauth";
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_FORM_BYTES = 16 * 1024;

export interface BrowserCredentials {
  email: string;
  password: string;
}

interface PrepareOAuthCLIOptions {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  browserLogin?: () => Promise<BrowserCredentials>;
}

export interface PreparedOAuthCLI {
  argv: string[];
  env: Record<string, string>;
  oauth: boolean;
}

interface BrowserLoginOptions {
  bindHost?: string;
  publicHost?: string;
  port?: number;
  timeoutMs?: number;
  token?: string;
  onUrl?: (url: URL) => void;
}

export async function prepareOAuthCLI(
  options: PrepareOAuthCLIOptions,
): Promise<PreparedOAuthCLI> {
  const oauthArguments = options.argv.filter(
    (argument) => argument === OAUTH_FLAG,
  );
  if (oauthArguments.length > 1) {
    throw new Error(`${OAUTH_FLAG} may only be specified once`);
  }
  const oauth = oauthArguments.length === 1;
  const argv = options.argv.filter((argument) => argument !== OAUTH_FLAG);
  const env = definedEnvironment(options.env);
  const isInformational = argv.some(
    (argument) =>
      argument === "--help" ||
      argument === "-h" ||
      argument === "--version" ||
      argument === "-V",
  );
  if (!oauth || isInformational) return { argv, env, oauth };

  const credentials = await (
    options.browserLogin ?? (() => browserLogin(env))
  )();
  env.CRADLEWISE_LOGIN = credentials.email;
  env.CRADLEWISE_PASSWORD = credentials.password;
  return { argv, env, oauth };
}

export async function startBrowserCredentialLogin(
  options: BrowserLoginOptions = {},
): Promise<BrowserCredentials> {
  const bindHost = options.bindHost ?? "0.0.0.0";
  const publicHost = options.publicHost ?? findLanAddress();
  const port = options.port ?? 0;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const token = options.token ?? randomBytes(24).toString("base64url");
  validateServerOptions(publicHost, port, timeoutMs, token);
  const path = `/login/${token}`;

  return await new Promise<BrowserCredentials>((resolve, reject) => {
    let settled = false;
    const server = createServer((request, response) => {
      void handleLoginRequest(request, response, path)
        .then((credentials) => {
          if (!credentials || settled) return;
          settled = true;
          clearTimeout(timeout);
          server.close(() => resolve(credentials));
        })
        .catch((error: unknown) => fail(error));
    });
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      server.close();
      reject(
        error instanceof Error
          ? error
          : new Error("Cradlewise browser login failed"),
      );
    };
    const timeout = setTimeout(
      () =>
        fail(new Error("Cradlewise browser login timed out after 5 minutes")),
      timeoutMs,
    );
    server.on("error", (error) => {
      fail(error);
    });
    server.listen(port, bindHost, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        fail(new Error("Unable to determine login server port"));
        return;
      }
      const url = new URL(
        `http://${formatUrlHost(publicHost)}:${address.port}${path}`,
      );
      options.onUrl?.(url);
    });
  });
}

async function browserLogin(
  env: Record<string, string>,
): Promise<BrowserCredentials> {
  const publicHost = env.CRADLEWISE_OAUTH_PUBLIC_HOST?.trim() || undefined;
  const bindHost = env.CRADLEWISE_OAUTH_BIND_HOST?.trim() || undefined;
  const configuredPort = env.CRADLEWISE_OAUTH_PORT;
  const port =
    configuredPort === undefined ? undefined : Number(configuredPort);
  return await startBrowserCredentialLogin({
    ...(publicHost === undefined ? {} : { publicHost }),
    ...(bindHost === undefined ? {} : { bindHost }),
    ...(port === undefined ? {} : { port }),
    onUrl: (url) => {
      process.stderr.write(`Cradlewise login URL: ${url.toString()}\n`);
      process.stderr.write(
        "Waiting up to 5 minutes for login from your browser...\n",
      );
    },
  });
}

async function handleLoginRequest(
  request: IncomingMessage,
  response: ServerResponse,
  path: string,
): Promise<BrowserCredentials | undefined> {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
  if (pathname !== path) {
    send(response, 404, "text/plain; charset=utf-8", "Not found\n");
    return undefined;
  }
  if (request.method === "GET") {
    send(response, 200, "text/html; charset=utf-8", LOGIN_PAGE);
    return undefined;
  }
  if (request.method !== "POST") {
    response.setHeader("Allow", "GET, POST");
    send(response, 405, "text/plain; charset=utf-8", "Method not allowed\n");
    return undefined;
  }
  const body = await readFormBody(request);
  const form = new URLSearchParams(body);
  const email = (form.get("email") ?? "").trim();
  const password = form.get("password") ?? "";
  if (!email || !password) {
    send(response, 400, "text/html; charset=utf-8", INVALID_PAGE);
    return undefined;
  }
  send(response, 200, "text/html; charset=utf-8", SUCCESS_PAGE);
  return { email, password };
}

async function readFormBody(request: IncomingMessage): Promise<string> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0];
  if (contentType !== "application/x-www-form-urlencoded") {
    throw new Error("Cradlewise login form used an unsupported content type");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    size += buffer.length;
    if (size > MAX_FORM_BYTES)
      throw new Error("Cradlewise login form is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(
  response: ServerResponse,
  status: number,
  contentType: string,
  body: string,
): void {
  response.writeHead(status, {
    "Content-Type": contentType,
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function findLanAddress(): string {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === "IPv4" && !address.internal)
        return address.address;
    }
  }
  throw new Error(
    "No LAN IPv4 address was found; set CRADLEWISE_OAUTH_PUBLIC_HOST to the hostname or address reachable by your browser",
  );
}

function validateServerOptions(
  publicHost: string,
  port: number,
  timeoutMs: number,
  token: string,
): void {
  if (!publicHost || /[\s/?#]/u.test(publicHost))
    throw new Error("Invalid OAuth public host");
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(
      "CRADLEWISE_OAUTH_PORT must be an integer from 0 through 65535",
    );
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error("OAuth timeout must be a positive integer");
  if (!/^[A-Za-z0-9_-]{16,}$/u.test(token))
    throw new Error("Invalid OAuth login token");
}

function formatUrlHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

const PAGE_STYLE =
  "body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#18202a}label{display:block;margin:1rem 0 .35rem}input{box-sizing:border-box;width:100%;padding:.7rem;border:1px solid #9aa4b2;border-radius:.4rem}button{margin-top:1.25rem;width:100%;padding:.8rem;border:0;border-radius:.4rem;background:#3157d5;color:white;font-weight:700}";
const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cradlewise login</title><style>${PAGE_STYLE}</style></head><body><h1>Sign in to Cradlewise</h1><p>Your credentials are sent only to the waiting CLI on this local network and are not stored.</p><form method="post"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required><button type="submit">Continue</button></form></body></html>`;
const INVALID_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cradlewise login</title><style>${PAGE_STYLE}</style></head><body><h1>Missing credentials</h1><p>Enter both your email and password, then try again.</p></body></html>`;
const SUCCESS_PAGE = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Cradlewise login complete</title><style>${PAGE_STYLE}</style></head><body><h1>Login received</h1><p>You can close this page and return to OpenClaw or Hermes.</p></body></html>`;
