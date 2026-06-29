import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const ROOT_DIRECTORY = resolve(import.meta.dirname, "..");
const OUTPUT_PATH = resolve(
  ROOT_DIRECTORY,
  "packages/homey-app/lib/generated/cradlewise-sdk.js",
);

const ENTRY = `
export { CradlewiseAuth } from "./dist/auth.js";
export { CradlewiseClient } from "./dist/client.js";
export { CradlewiseController } from "./dist/controls.js";
export {
  AppConfig,
  getAppConfig,
  isTrustedDiscoveredAppConfig,
} from "./dist/config.js";
`;

export async function buildHomeySdkRuntime({ write = true } = {}) {
  const result = await build({
    absWorkingDir: ROOT_DIRECTORY,
    bundle: true,
    charset: "utf8",
    conditions: ["browser", "import", "module", "default"],
    external: ["node:*", "mqtt"],
    format: "cjs",
    legalComments: "none",
    logLevel: "silent",
    platform: "browser",
    sourcemap: false,
    stdin: {
      contents: ENTRY,
      loader: "js",
      resolveDir: ROOT_DIRECTORY,
      sourcefile: "homey-sdk-runtime.js",
    },
    target: "es2022",
    write: false,
  });
  if (result.outputFiles.length !== 1) {
    throw new Error("Expected one generated Homey SDK runtime file");
  }
  const contents = result.outputFiles[0].contents;
  if (!write) return contents;

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  const temporaryPath = `${OUTPUT_PATH}.tmp`;
  try {
    await writeFile(temporaryPath, contents, { mode: 0o644 });
    await rename(temporaryPath, OUTPUT_PATH);
  } finally {
    await rm(temporaryPath, { force: true });
  }
  return contents;
}

export async function verifyHomeySdkRuntime(path = OUTPUT_PATH) {
  const expected = Buffer.from(await buildHomeySdkRuntime({ write: false }));
  const actual = await readFile(path);
  if (!actual.equals(expected)) {
    throw new Error(
      `Generated Homey SDK runtime is stale (expected ${digest(expected)}, found ${digest(actual)})`,
    );
  }
  return Object.freeze({ bytes: actual.length });
}

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(import.meta.filename)
) {
  const contents = await buildHomeySdkRuntime();
  process.stdout.write(
    `Generated Homey SDK runtime (${contents.length} bytes)\n`,
  );
}
