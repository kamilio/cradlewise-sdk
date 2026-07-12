import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";

export const OAUTH_FLAG = "--oauth";

interface PromptStreams {
  input: NodeJS.ReadableStream & { isTTY?: boolean };
  output: NodeJS.WritableStream & { isTTY?: boolean };
}

interface PrepareOAuthCLIOptions {
  argv: readonly string[];
  env: NodeJS.ProcessEnv;
  prompt?: (label: string, secret?: boolean) => Promise<string>;
}

export interface PreparedOAuthCLI {
  argv: string[];
  env: Record<string, string>;
  oauth: boolean;
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

  const prompt = options.prompt ?? promptLine;
  const email = (await prompt("Cradlewise account email: ")).trim();
  if (email.length === 0)
    throw new Error("Cradlewise account email is required");
  const password = await prompt("Cradlewise account password: ", true);
  if (password.length === 0)
    throw new Error("Cradlewise account password is required");
  env.CRADLEWISE_LOGIN = email;
  env.CRADLEWISE_PASSWORD = password;
  return { argv, env, oauth };
}

export async function promptLine(
  label: string,
  secret = false,
  streams: PromptStreams = { input: process.stdin, output: process.stdout },
): Promise<string> {
  if (!streams.input.isTTY || !streams.output.isTTY) {
    throw new Error(
      `${label.replace(/:\s*$/, "")} requires an interactive terminal; use CRADLEWISE_LOGIN and CRADLEWISE_PASSWORD for non-interactive use`,
    );
  }
  let muted = false;
  const output = new Writable({
    write(
      chunk: string | Buffer,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void,
    ) {
      if (muted) callback();
      else if (typeof chunk === "string")
        streams.output.write(chunk, encoding, callback);
      else streams.output.write(chunk, callback);
    },
  });
  const readline = createInterface({
    input: streams.input,
    output,
    terminal: true,
  });
  try {
    if (!secret) return await readline.question(label);
    streams.output.write(label);
    muted = true;
    const value = await readline.question("");
    muted = false;
    streams.output.write("\n");
    return value;
  } finally {
    muted = false;
    readline.close();
  }
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}
