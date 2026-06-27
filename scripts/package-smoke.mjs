import { spawn } from "node:child_process";
import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reviewedChildEnvironment } from "../packages/homey-app/scripts/child-environment.mjs";
import {
  forwardCommandSignals,
  terminateCommand,
} from "../packages/homey-app/scripts/command-process.mjs";
import {
  PACKAGE_NAME,
  PACKAGE_VERSION,
  CradlewiseClient,
  isLegacyRealtimeSdkAvailable,
  isRealtimeAvailable,
  isApiBaseUrlForRegion,
  isAwsIotEndpointForRegion,
  parseEventTime,
} from "../dist/index.js";
/** @type {import("../dist/index.js").CradlewiseApiErrorOptions} */
const apiErrorOptions = { status: 500 };
import { cradlewiseToolcraftRoot } from "../dist/toolcraft.js";

if (typeof CradlewiseClient !== "function")
  throw new Error("Root export is not loadable");
if (
  typeof CradlewiseClient.prototype.getUserDeviceIds !== "function" ||
  typeof CradlewiseClient.prototype.getInboxMessages !== "function" ||
  typeof CradlewiseClient.prototype.getLatestCribPhoto !== "function"
) {
  throw new Error("Published inbox photo methods are not loadable");
}
const cliMetadata = requireSafeArtifact("dist/cli.js", 16 * 1024 * 1024);
if (process.platform !== "win32" && (cliMetadata.mode & 0o111) === 0)
  throw new Error("Published CLI entry point must be executable");
if (apiErrorOptions.status !== 500)
  throw new Error("API error option type smoke failed");
if (!Number.isFinite(parseEventTime("2026-01-01 00:00:00")))
  throw new Error("Timestamp parser export is not loadable");
if (
  !isApiBaseUrlForRegion("https://backend.cradlewise.com/api", "us-east-1") ||
  !isAwsIotEndpointForRegion(
    "example-ats.iot.us-east-1.amazonaws.com",
    "us-east-1",
  )
)
  throw new Error("IoT endpoint validator export is not loadable");
if (cradlewiseToolcraftRoot.name !== PACKAGE_NAME)
  throw new Error("Toolcraft root name drifted");
if (await isRealtimeAvailable())
  throw new Error("Unsupported current realtime was reported as available");
if (!(await isLegacyRealtimeSdkAvailable()))
  throw new Error("Installed optional legacy realtime SDK was not detected");

for (const filename of readdirSync("dist").filter((entry) =>
  entry.endsWith(".map"),
)) {
  requireSafeArtifact(`dist/${filename}`, 16 * 1024 * 1024);
  const sourceMap = JSON.parse(readFileSync(`dist/${filename}`, "utf8"));
  if (
    !Array.isArray(sourceMap.sources) ||
    sourceMap.sources.length === 0 ||
    sourceMap.sources.some(
      (source) =>
        typeof source !== "string" ||
        source.length === 0 ||
        source.length > 4096 ||
        source.startsWith("/") ||
        /^[A-Za-z]:[\\/]/.test(source) ||
        source.includes("\\") ||
        source.includes("://") ||
        Array.from(source).some((character) => {
          const code = character.charCodeAt(0);
          return code <= 31 || (code >= 127 && code <= 159);
        }),
    )
  ) {
    throw new Error(
      `Published source map ${filename} must use relative source paths`,
    );
  }
  if (
    filename.endsWith(".js.map") &&
    (!Array.isArray(sourceMap.sourcesContent) ||
      sourceMap.sourcesContent.length !== sourceMap.sources.length ||
      sourceMap.sourcesContent.some((content) => typeof content !== "string"))
  ) {
    throw new Error(
      `Published JavaScript source map ${filename} must embed every source`,
    );
  }
}

const version = spawnSync(process.execPath, ["dist/cli.js", "--version"], {
  encoding: "utf8",
  env: reviewedChildEnvironment(process.env),
  maxBuffer: 1024 * 1024,
  timeout: 10_000,
});
if (
  version.error ||
  version.status !== 0 ||
  version.stdout.trim() !== PACKAGE_VERSION
) {
  throw new Error(`CLI version mismatch: ${version.stdout || version.stderr}`);
}
if (process.platform !== "win32") {
  const executableVersion = spawnSync("./dist/cli.js", ["--version"], {
    encoding: "utf8",
    env: reviewedChildEnvironment(process.env),
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
  });
  if (
    executableVersion.error ||
    executableVersion.status !== 0 ||
    executableVersion.stdout.trim() !== PACKAGE_VERSION
  ) {
    throw new Error("CLI executable entry point failed");
  }
}

const secretMarkers = ["marker-login-secret", "marker-password-secret"];
const redactSecretMarkers = (value) =>
  secretMarkers.reduce(
    (redacted, secret) => redacted.replaceAll(secret, "[REDACTED]"),
    String(value),
  );
const invalidCli = spawnSync(
  process.execPath,
  [
    "dist/cli.js",
    "analytics",
    "--cradle-id",
    "crib",
    "--start-hour",
    "24",
    "--output",
    "json",
  ],
  {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    timeout: 10_000,
    env: Object.assign(reviewedChildEnvironment(process.env), {
      CRADLEWISE_LOGIN: secretMarkers[0],
      CRADLEWISE_PASSWORD: secretMarkers[1],
    }),
  },
);
const invalidCliOutput = invalidCli.stdout + invalidCli.stderr;
if (
  invalidCli.error ||
  invalidCli.status === 0 ||
  !invalidCliOutput.includes("Invalid value") ||
  secretMarkers.some((secret) => invalidCliOutput.includes(secret))
) {
  throw new Error(
    `CLI validation/redaction failed: ${redactSecretMarkers(invalidCliOutput)}`,
  );
}

const child = spawn(process.execPath, ["dist/cli.js", "mcp"], {
  detached: process.platform !== "win32",
  stdio: ["pipe", "pipe", "pipe"],
  env: Object.assign(reviewedChildEnvironment(process.env), {
    CRADLEWISE_LOGIN: secretMarkers[0],
    CRADLEWISE_PASSWORD: secretMarkers[1],
  }),
});
let output = "";
let errors = "";
const maximumChildOutput = 1024 * 1024;
let outputExceeded = false;
const signalForwarding = forwardCommandSignals(child);
const appendOutput = (current, chunk) => {
  const next = current + String(chunk);
  if (Buffer.byteLength(next) > maximumChildOutput) {
    outputExceeded = true;
    terminateCommand(child, "SIGTERM");
    return current;
  }
  return next;
};
child.stdout.on("data", (chunk) => (output = appendOutput(output, chunk)));
child.stderr.on("data", (chunk) => (errors = appendOutput(errors, chunk)));
child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "package-smoke", version: "1" },
    },
  })}\n`,
);
child.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} })}\n`,
);
child.stdin.write(
  `${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
);
child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "cradlewise__analytics",
      arguments: { cradle_id: "crib", start_hour: 24 },
    },
  })}\n`,
);
child.stdin.end();

let timedOut = false;
let hardTimeout;
const timeout = setTimeout(() => {
  timedOut = true;
  terminateCommand(child, "SIGTERM");
  hardTimeout = setTimeout(() => terminateCommand(child, "SIGKILL"), 1_000);
}, 2_000);
let exit;
try {
  exit = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
} finally {
  signalForwarding.stop();
}
clearTimeout(timeout);
if (hardTimeout) clearTimeout(hardTimeout);
if (timedOut) throw new Error("MCP smoke process timed out");
if (outputExceeded) throw new Error("MCP smoke process exceeded output limits");
if (signalForwarding.forwardedSignal) {
  throw new Error(
    `MCP smoke process interrupted by ${signalForwarding.forwardedSignal}`,
  );
}
if (secretMarkers.some((secret) => (output + errors).includes(secret))) {
  throw new Error("MCP output exposed a configured secret");
}
if (exit.code !== 0) {
  throw new Error(
    `MCP smoke process failed (${String(exit.signal ?? exit.code)}): ${redactSecretMarkers(errors || output)}`,
  );
}
let messages;
try {
  messages = output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
} catch (error) {
  throw new Error(
    `MCP smoke process emitted invalid JSON: ${redactSecretMarkers(errors || output)}`,
    {
      cause: error,
    },
  );
}
const tools = messages.find((message) => message.id === 2)?.result?.tools;
const toolNames = Array.isArray(tools) ? tools.map((tool) => tool.name) : [];
if (
  !Array.isArray(tools) ||
  toolNames.join(",") !==
    "cradlewise__list,cradlewise__status,cradlewise__analytics"
) {
  throw new Error(
    `MCP tools/list failed: ${redactSecretMarkers(errors || output)}`,
  );
}
if (!tools.every((tool) => tool.outputSchema)) {
  throw new Error("Every MCP tool must expose an output schema");
}
const listTool = tools.find((tool) => tool.name === "cradlewise__list");
if (
  listTool?.outputSchema?.properties?.cradles?.items?.properties?.cradle_id
    ?.type !== "string" ||
  listTool.outputSchema.properties.cradles.items.properties.state?.type !==
    undefined ||
  listTool.outputSchema.properties.cradles.items.properties.status_partial
    ?.type !== "boolean"
) {
  throw new Error("MCP crib output schema is incomplete");
}
const analyticsTool = tools.find(
  (tool) => tool.name === "cradlewise__analytics",
);
if (
  analyticsTool?.inputSchema?.properties?.cradle_id?.minLength !== 1 ||
  analyticsTool.inputSchema.properties.cradle_id?.maxLength !== 256 ||
  analyticsTool.inputSchema.properties.start_date?.minLength !== 1 ||
  analyticsTool.inputSchema.properties.start_date?.maxLength !== 64 ||
  analyticsTool.inputSchema.properties.end_date?.minLength !== 1 ||
  analyticsTool.inputSchema.properties.end_date?.maxLength !== 64
) {
  throw new Error("MCP analytics string bounds are missing");
}
if (
  analyticsTool.outputSchema?.properties?.analytics?.properties
    ?.total_sleep_minutes?.type !== "integer" ||
  analyticsTool.outputSchema.properties.analytics.properties.partial?.type !==
    "boolean"
) {
  throw new Error("MCP analytics output schema is incomplete");
}
const invalidToolCall = messages.find((message) => message.id === 3);
if (
  invalidToolCall?.error?.code !== -32602 ||
  !invalidToolCall.error.message.includes("Invalid value")
) {
  throw new Error(
    `MCP argument validation failed: ${redactSecretMarkers(errors || output)}`,
  );
}

const coreSmokeRoot = mkdtempSync(join(tmpdir(), "cradlewise-core-smoke-"));
try {
  const packageRoot = resolve(import.meta.dirname, "..");
  const pack = runChecked(
    "npm",
    [
      "pack",
      packageRoot,
      "--pack-destination",
      coreSmokeRoot,
      "--ignore-scripts",
      "--silent",
    ],
    packageRoot,
  );
  const tarballName = pack.stdout.trim();
  if (
    !/^cradlewise-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/.test(tarballName)
  ) {
    throw new Error("Core-only package smoke received an invalid tarball name");
  }
  const consumer = join(coreSmokeRoot, "consumer");
  writeFileSync(
    join(coreSmokeRoot, "package.json"),
    `${JSON.stringify({ private: true })}\n`,
  );
  runChecked(
    "npm",
    [
      "install",
      join(coreSmokeRoot, tarballName),
      "--ignore-scripts",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--prefix",
      consumer,
    ],
    coreSmokeRoot,
  );
  for (const omitted of ["toolcraft", "toolcraft-schema"]) {
    if (existsSync(join(consumer, "node_modules", omitted))) {
      throw new Error(`Core-only package smoke installed ${omitted}`);
    }
  }
  runChecked(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const sdk = await import('cradlewise'); if (typeof sdk.CradlewiseClient !== 'function' || typeof sdk.getAppConfig !== 'function') throw new Error('core export unavailable');",
    ],
    consumer,
  );
} finally {
  rmSync(coreSmokeRoot, { recursive: true, force: true });
}

console.log("Package, CLI, MCP, and core-only smoke tests passed");

function runChecked(command, arguments_, cwd) {
  const result = spawnSync(command, arguments_, {
    cwd,
    encoding: "utf8",
    env: reviewedChildEnvironment(process.env),
    maxBuffer: 2 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(
      `${command} ${arguments_.join(" ")} failed: ${result.stderr || result.stdout}`,
      result.error ? { cause: result.error } : undefined,
    );
  }
  return result;
}

function requireSafeArtifact(path, maximumBytes) {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > maximumBytes
  ) {
    throw new Error(`Published artifact is not a safe regular file: ${path}`);
  }
  return metadata;
}
