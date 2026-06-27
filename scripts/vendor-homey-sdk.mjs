import {
  copyFile,
  lstat,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  forwardCommandSignals,
  terminateCommand,
} from "../packages/homey-app/scripts/command-process.mjs";
import { reviewedChildEnvironment } from "../packages/homey-app/scripts/child-environment.mjs";

const root = resolve(import.meta.dirname, "..");
const homey = join(root, "packages", "homey-app");
const vendor = join(homey, "vendor");
const homeyPackagePath = join(homey, "package.json");
const homeyLockPath = join(homey, "package-lock.json");
const vendorLockPath = join(homey, ".vendor.lock");
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const COMMAND_KILL_GRACE_MS = 5 * 1000;
const MAX_VENDOR_TARBALL_BYTES = 16 * 1024 * 1024;

export async function vendorHomeySdk() {
  return withVendorLock(vendorHomeySdkUnlocked);
}

async function vendorHomeySdkUnlocked() {
  await assertDirectory(vendor);
  for (const file of [homeyPackagePath, homeyLockPath])
    await assertRegularFile(file);
  const originalFiles = new Map([
    [homeyPackagePath, await readFile(homeyPackagePath)],
    [homeyLockPath, await readFile(homeyLockPath)],
  ]);
  const originalTarballs = new Map();
  for (const file of await sdkTarballs(vendor)) {
    originalTarballs.set(file, await readFile(join(vendor, file)));
  }
  const temporary = await mkdtemp(join(tmpdir(), "cradlewise-homey-vendor-"));
  let transactionStarted = false;

  return withVendorCleanup(
    async () => {
      try {
        await runCommand(
          "npm",
          ["pack", root, "--pack-destination", temporary, "--ignore-scripts"],
          root,
        );
        const packed = await sdkTarballs(temporary);
        if (packed.length !== 1) {
          throw new Error(
            `Expected one packed Cradlewise SDK tarball, found ${packed.length}`,
          );
        }
        const filename = packed[0];
        transactionStarted = true;
        await replaceTarball(join(temporary, filename), join(vendor, filename));
        await rm(join(homey, "node_modules", "cradlewise"), {
          recursive: true,
          force: true,
        });
        await runCommand(
          "npm",
          [
            "install",
            "--package-lock-only",
            "--ignore-scripts",
            "--save-exact",
            `./vendor/${filename}`,
          ],
          homey,
        );
        await runCommand("npm", ["ci", "--ignore-scripts"], homey);
        for (const file of await sdkTarballs(vendor)) {
          if (file !== filename) await rm(join(vendor, file), { force: true });
        }
        process.stdout.write(`Vendored ${filename}\n`);
      } catch (error) {
        if (transactionStarted) {
          try {
            await rollback(originalFiles, originalTarballs);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Vendoring failed and rollback was incomplete",
              { cause: rollbackError },
            );
          }
        }
        throw error;
      }
    },
    () => rm(temporary, { recursive: true, force: true }),
    "Vendoring and temporary-directory cleanup failed",
  );
}

export async function withVendorLock(
  operation,
  lockPath = vendorLockPath,
  { openFile = open, removeFile = rm } = {},
) {
  let handle;
  try {
    handle = await openFile(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another Homey SDK vendoring transaction is active", {
        cause: error,
      });
    }
    throw normalizeError(error, "Vendoring transaction lock failed");
  }
  let result;
  let primaryError = null;
  try {
    result = await operation();
  } catch (error) {
    primaryError = normalizeError(error, "Vendoring transaction failed");
  }
  const cleanupErrors = [];
  try {
    await handle.close();
  } catch (error) {
    cleanupErrors.push(normalizeError(error, "Vendoring lock close failed"));
  }
  try {
    await removeFile(lockPath, { force: true });
  } catch (error) {
    cleanupErrors.push(normalizeError(error, "Vendoring lock removal failed"));
  }
  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Vendoring and transaction-lock cleanup failed",
      { cause: cleanupErrors.at(-1) },
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Vendoring transaction-lock cleanup failed",
      { cause: cleanupErrors.at(-1) },
    );
  }
  return result;
}

function normalizeError(value, message) {
  return value instanceof Error ? value : new Error(message, { cause: value });
}

export async function rollback(
  originalFiles,
  originalTarballs,
  {
    vendorDirectory = vendor,
    homeyDirectory = homey,
    write = writeFile,
    remove = rm,
    listTarballs = sdkTarballs,
    runCommand,
  } = {},
) {
  const rollbackErrors = [];
  const attempt = async (operation) => {
    try {
      await operation();
    } catch (error) {
      rollbackErrors.push(error);
    }
  };
  for (const [file, contents] of originalFiles) {
    await attempt(() => write(file, contents));
  }
  let currentTarballs = [];
  await attempt(async () => {
    currentTarballs = await listTarballs(vendorDirectory);
  });
  for (const file of currentTarballs) {
    await attempt(() => remove(join(vendorDirectory, file), { force: true }));
  }
  for (const [file, contents] of originalTarballs) {
    await attempt(() => write(join(vendorDirectory, file), contents));
  }
  await attempt(() =>
    runCommand("npm", ["ci", "--ignore-scripts"], homeyDirectory),
  );
  if (rollbackErrors.length === 1) throw rollbackErrors[0];
  if (rollbackErrors.length > 1) {
    throw new AggregateError(rollbackErrors, "Vendoring rollback failed", {
      cause: rollbackErrors.at(-1),
    });
  }
}

export async function sdkTarballs(directory) {
  const names = [];
  for (const file of await readdir(directory)) {
    if (!file.startsWith("cradlewise-") && !file.endsWith(".tgz")) continue;
    if (!/^cradlewise-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.tgz$/u.test(file)) {
      throw new Error("Vendored Cradlewise SDK tarball name is unsafe");
    }
    const metadata = await assertRegularFile(join(directory, file));
    if (metadata.size <= 0 || metadata.size > MAX_VENDOR_TARBALL_BYTES) {
      throw new Error("Vendored Cradlewise SDK tarball size is unsafe");
    }
    names.push(file);
  }
  return names;
}

export async function replaceTarball(
  source,
  destination,
  temporaryTarball = `${destination}.${randomUUID()}.tmp`,
) {
  return withVendorCleanup(
    async () => {
      await copyFile(source, temporaryTarball, constants.COPYFILE_EXCL);
      await rename(temporaryTarball, destination);
    },
    () => rm(temporaryTarball, { force: true }),
    "Vendored tarball replacement and cleanup failed",
  );
}

export async function withVendorCleanup(operation, cleanup, message) {
  let result;
  let primaryError;
  try {
    result = await operation();
  } catch (error) {
    primaryError = normalizeError(error, "Vendoring operation failed");
  }
  let cleanupError;
  try {
    await cleanup();
  } catch (error) {
    cleanupError = normalizeError(error, "Vendoring cleanup failed");
  }
  if (primaryError && cleanupError) {
    throw new AggregateError([primaryError, cleanupError], message, {
      cause: cleanupError,
    });
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;
  return result;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  await vendorHomeySdk();
}

async function assertDirectory(directory) {
  const stats = await lstat(directory);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Expected a real directory: ${directory}`);
  }
}

async function assertRegularFile(file) {
  const stats = await lstat(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
    throw new Error(`Expected a single-link regular file: ${file}`);
  }
  return stats;
}

export function runCommand(
  command,
  args,
  cwd,
  { timeoutMs = COMMAND_TIMEOUT_MS, killGraceMs = COMMAND_KILL_GRACE_MS } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      detached: process.platform !== "win32",
      env: reviewedChildEnvironment(process.env),
      stdio: "inherit",
    });
    let timeoutError;
    let forceTimer;
    const signalForwarding = forwardCommandSignals(child);
    const timer = setTimeout(() => {
      timeoutError = new Error(`${command} ${args.join(" ")} timed out`);
      terminateCommand(child, "SIGTERM");
      forceTimer = setTimeout(
        () => terminateCommand(child, "SIGKILL"),
        killGraceMs,
      );
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signalForwarding.stop();
      reject(error);
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      signalForwarding.stop();
      if (timeoutError instanceof Error) reject(timeoutError);
      else if (signalForwarding.forwardedSignal)
        reject(
          new Error(
            `${command} ${args.join(" ")} interrupted by ${signalForwarding.forwardedSignal}`,
          ),
        );
      else if (code === 0) resolve();
      else
        reject(
          new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`),
        );
    });
  });
}
