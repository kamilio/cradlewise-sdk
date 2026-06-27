import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { gunzipSync } from "node:zlib";

const directory = mkdtempSync(join(tmpdir(), "cradlewise-attw-"));
const MAX_PACKED_FILES = 1000;
const MAX_PACKED_FILE_BYTES = 16 * 1024 * 1024;
const MAX_PACKED_CONTENT_BYTES = 64 * 1024 * 1024;
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;
const MAX_UNPACKED_TAR_BYTES = 128 * 1024 * 1024;

try {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const packed = spawnSync(
    npm,
    ["pack", "--json", "--pack-destination", directory],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        npm_config_dry_run: "false",
        npm_config_ignore_scripts: "true",
      },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
    },
  );
  if (packed.error || packed.status !== 0) {
    throw new Error(packed.stderr || packed.stdout || "npm pack failed");
  }

  const manifest = JSON.parse(packed.stdout);
  if (
    !Array.isArray(manifest) ||
    manifest.length !== 1 ||
    !isRecord(manifest[0]) ||
    typeof manifest[0].filename !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(manifest[0].filename) ||
    !Array.isArray(manifest[0].files) ||
    manifest[0].files.length === 0 ||
    manifest[0].files.length > MAX_PACKED_FILES
  ) {
    throw new Error("npm pack returned an invalid artifact manifest");
  }
  const { filename, files } = manifest[0];
  let packedContentBytes = 0;
  const fileMetadataByPath = new Map();
  for (const file of files) {
    if (
      !isRecord(file) ||
      typeof file.path !== "string" ||
      file.path.length === 0 ||
      file.path.length > 4096 ||
      file.path.includes("\\") ||
      file.path
        .split("/")
        .some((part) => part.length === 0 || part === "." || part === "..") ||
      Array.from(file.path).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || (code >= 127 && code <= 159);
      }) ||
      fileMetadataByPath.has(file.path) ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > MAX_PACKED_FILE_BYTES
    ) {
      throw new Error("npm pack returned invalid file metadata");
    }
    fileMetadataByPath.set(file.path, file);
    packedContentBytes += file.size;
    if (packedContentBytes > MAX_PACKED_CONTENT_BYTES) {
      throw new Error("Packed artifact exceeds the content size limit");
    }
  }
  const paths = files.map((file) => file.path);
  const requiredPaths = [
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "dist/index.js",
    "dist/index.d.ts",
    "src/index.ts",
    "docs/engineering-log.md",
    "package.json",
  ];
  for (const path of requiredPaths) {
    if (!paths.includes(path))
      throw new Error(`Packed artifact is missing ${path}`);
  }
  const cliEntry = files.find((file) => file.path === "dist/cli.js");
  if (
    process.platform !== "win32" &&
    (typeof cliEntry?.mode !== "number" || (cliEntry.mode & 0o111) === 0)
  ) {
    throw new Error("Packed CLI entry point is not executable");
  }
  const allowedTopLevels = new Set([
    "CHANGELOG.md",
    "LICENSE",
    "README.md",
    "SECURITY.md",
    "dist",
    "docs",
    "package.json",
    "src",
  ]);
  for (const path of paths) {
    const topLevel = path.split("/")[0];
    if (!allowedTopLevels.has(topLevel)) {
      throw new Error(`Unexpected packed artifact path: ${path}`);
    }
    const basename = path.split("/").at(-1)?.toLowerCase() ?? "";
    if (
      basename.startsWith(".") ||
      /\.(?:env|pem|key|p12|pfx|jks|keystore|crt|cer)$/i.test(basename) ||
      /^(?:credentials|secrets)(?:\.|$)/i.test(basename)
    ) {
      throw new Error(`Sensitive-looking packed artifact path: ${path}`);
    }
    const metadata = lstatSync(path);
    const declared = fileMetadataByPath.get(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size !== declared?.size
    ) {
      throw new Error(`Packed source is not a safe regular file: ${path}`);
    }
  }
  const localEnvironmentValues = existsSync(".env")
    ? Object.values(parseEnv(readPrivateLocalFile(".env"))).filter(
        (value) => value.length >= 8,
      )
    : [];
  const localConfigPath = join(
    homedir(),
    ".cradlewise",
    "cradlewise_app_config.json",
  );
  const localConfigValues = existsSync(localConfigPath)
    ? readCachedConfigValues(localConfigPath)
    : [];
  const localSensitiveValues = [
    ...new Set([...localEnvironmentValues, ...localConfigValues]),
  ];
  const sensitiveContentPatterns = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/,
    /\bnpm_[A-Za-z0-9]{36}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/,
  ];
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const contents = readFileSync(path, "utf8");
    if (sensitiveContentPatterns.some((pattern) => pattern.test(contents))) {
      throw new Error(
        `Packed artifact contains sensitive-looking content: ${path}`,
      );
    }
    if (localSensitiveValues.some((secret) => contents.includes(secret))) {
      throw new Error(
        `Packed artifact contains a local sensitive value: ${path}`,
      );
    }
  }
  const tarball = join(directory, filename);
  const tarballMetadata = lstatSync(tarball);
  if (
    !tarballMetadata.isFile() ||
    tarballMetadata.isSymbolicLink() ||
    tarballMetadata.nlink !== 1 ||
    tarballMetadata.size <= 0 ||
    tarballMetadata.size > MAX_TARBALL_BYTES
  ) {
    throw new Error("Packed tar archive is not a safe regular file");
  }
  const unpackedTar = gunzipSync(readFileSync(tarball), {
    maxOutputLength: MAX_UNPACKED_TAR_BYTES,
  }).toString("utf8");
  if (
    sensitiveContentPatterns.some((pattern) => pattern.test(unpackedTar)) ||
    localSensitiveValues.some((secret) => unpackedTar.includes(secret))
  ) {
    throw new Error("Packed tar archive contains sensitive-looking content");
  }

  const attw = process.platform === "win32" ? "attw.cmd" : "attw";
  const checked = spawnSync(attw, [tarball, "--profile", "esm-only"], {
    encoding: "utf8",
    stdio: "inherit",
    timeout: 120_000,
  });
  if (checked.error || checked.status !== 0) {
    throw new Error(`ATTW exited with status ${checked.status ?? "unknown"}`);
  }
} finally {
  rmSync(directory, { force: true, recursive: true });
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readCachedConfigValues(path) {
  const contents = readPrivateLocalFile(path);
  try {
    const config = JSON.parse(contents);
    return [
      config.cognitoUserPoolId,
      config.cognitoAppClientId,
      config.cognitoAppClientSecret,
      config.cognitoIdentityPoolId,
      config.iotEndpoint,
    ].filter((value) => typeof value === "string" && value.length >= 8);
  } catch {
    return [];
  }
}

function readPrivateLocalFile(path) {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.nlink !== 1 ||
    metadata.size <= 0 ||
    metadata.size > 1024 * 1024 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error(`Local secret input is not a safe private file: ${path}`);
  }
  return readFileSync(path, "utf8");
}
