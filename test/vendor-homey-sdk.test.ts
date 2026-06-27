import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const fixtures: string[] = [];

interface RollbackOptions {
  vendorDirectory?: string;
  homeyDirectory?: string;
  write?: (path: string, contents: Uint8Array) => Promise<void>;
  remove?: (path: string, options: { force: boolean }) => Promise<void>;
  listTarballs?: (directory: string) => Promise<string[]>;
  runCommand?: () => Promise<void>;
}

async function loadReplaceTarball(): Promise<
  (source: string, destination: string, temporary: string) => Promise<void>
> {
  return (await import("../scripts/vendor-homey-sdk.mjs")).replaceTarball;
}

async function loadRollback(): Promise<
  (
    originalFiles: Map<string, Buffer>,
    originalTarballs: Map<string, Buffer>,
    options: RollbackOptions,
  ) => Promise<void>
> {
  return (await import("../scripts/vendor-homey-sdk.mjs")).rollback;
}

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((fixture) => rm(fixture, { recursive: true, force: true })),
  );
});

describe("Homey SDK vendoring", () => {
  it("retains vendoring operation and temporary cleanup failures", async () => {
    const operationError = new Error("operation failed");
    const cleanupError = new Error("cleanup failed");
    const { withVendorCleanup } =
      await import("../scripts/vendor-homey-sdk.mjs");

    await expect(
      withVendorCleanup(
        () => Promise.reject(operationError),
        () => Promise.reject(cleanupError),
        "vendoring cleanup failed",
      ),
    ).rejects.toMatchObject({
      errors: [operationError, cleanupError],
      cause: cleanupError,
    });
  });

  it("serializes vendoring transactions with an exclusive lock", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "homey-vendor-lock-test-"));
    fixtures.push(fixture);
    const lock = join(fixture, ".vendor.lock");
    let release!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { withVendorLock } = await import("../scripts/vendor-homey-sdk.mjs");
    const first = withVendorLock(async () => {
      markStarted();
      await waiting;
      return "complete";
    }, lock);

    await started;
    await expect(
      withVendorLock(() => Promise.resolve(undefined), lock),
    ).rejects.toThrow(/vendoring transaction is active/u);
    release();
    await expect(first).resolves.toBe("complete");
    await expect(access(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("retains vendoring and lock-cleanup failures", async () => {
    const operationError = new Error("operation failed");
    const closeError = new Error("close failed");
    const removeError = new Error("remove failed");
    const { withVendorLock } = await import("../scripts/vendor-homey-sdk.mjs");

    await expect(
      withVendorLock(() => Promise.reject(operationError), "/unused/lock", {
        openFile: () =>
          Promise.resolve({
            close: () => Promise.reject(closeError),
          }),
        removeFile: () => Promise.reject(removeError),
      }),
    ).rejects.toMatchObject({
      errors: [operationError, closeError, removeError],
      cause: removeError,
    });
  });

  it("surfaces a failed dependency reinstall after restoring vendored files", async () => {
    const fixture = await mkdtemp(
      join(tmpdir(), "homey-vendor-rollback-test-"),
    );
    fixtures.push(fixture);
    const vendor = join(fixture, "vendor");
    await mkdir(vendor);
    const packageFile = join(fixture, "package.json");
    const lockFile = join(fixture, "package-lock.json");
    await writeFile(packageFile, "changed package\n");
    await writeFile(lockFile, "changed lock\n");
    await writeFile(join(vendor, "cradlewise-0.2.0.tgz"), "new archive\n");
    const reinstallError = new Error("reinstall failed");
    const rollback = await loadRollback();

    await expect(
      rollback(
        new Map([
          [packageFile, Buffer.from("old package\n")],
          [lockFile, Buffer.from("old lock\n")],
        ]),
        new Map([["cradlewise-0.1.0.tgz", Buffer.from("old archive\n")]]),
        {
          vendorDirectory: vendor,
          homeyDirectory: fixture,
          runCommand: () => Promise.reject(reinstallError),
        },
      ),
    ).rejects.toBe(reinstallError);
    await expect(readFile(packageFile, "utf8")).resolves.toBe("old package\n");
    await expect(readFile(lockFile, "utf8")).resolves.toBe("old lock\n");
    await expect(readdir(vendor)).resolves.toEqual(["cradlewise-0.1.0.tgz"]);
    await expect(
      readFile(join(vendor, "cradlewise-0.1.0.tgz"), "utf8"),
    ).resolves.toBe("old archive\n");
  });

  it("attempts every rollback step and retains all restoration failures", async () => {
    const writeError = new Error("write failed");
    const scanError = new Error("scan failed");
    const reinstallError = new Error("reinstall failed");
    const writes: string[] = [];
    const rollback = await loadRollback();

    await expect(
      rollback(
        new Map([
          ["/package.json", Buffer.from("package")],
          ["/package-lock.json", Buffer.from("lock")],
        ]),
        new Map([["cradlewise-0.1.0.tgz", Buffer.from("archive")]]),
        {
          vendorDirectory: "/vendor",
          homeyDirectory: "/homey",
          write: (path) => {
            writes.push(path);
            return path === "/package.json"
              ? Promise.reject(writeError)
              : Promise.resolve();
          },
          listTarballs: () => Promise.reject(scanError),
          runCommand: () => Promise.reject(reinstallError),
        },
      ),
    ).rejects.toMatchObject({
      errors: [writeError, scanError, reinstallError],
      cause: reinstallError,
    });
    expect(writes).toEqual([
      "/package.json",
      "/package-lock.json",
      "/vendor/cradlewise-0.1.0.tgz",
    ]);
  });

  it("accepts only bounded semantic-version SDK tarballs", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "homey-vendor-scan-test-"));
    fixtures.push(fixture);
    await writeFile(join(fixture, "cradlewise-0.1.0.tgz"), "archive\n");
    const { sdkTarballs } = await import("../scripts/vendor-homey-sdk.mjs");

    await expect(sdkTarballs(fixture)).resolves.toEqual([
      "cradlewise-0.1.0.tgz",
    ]);

    await writeFile(join(fixture, "cradlewise-unsafe\n.tgz"), "archive\n");
    await expect(sdkTarballs(fixture)).rejects.toThrow(/name is unsafe/u);
  });

  it("rejects oversized SDK tarballs", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "homey-vendor-size-test-"));
    fixtures.push(fixture);
    const tarball = join(fixture, "cradlewise-0.1.0.tgz");
    await writeFile(tarball, "");
    await truncate(tarball, 16 * 1024 * 1024 + 1);
    const { sdkTarballs } = await import("../scripts/vendor-homey-sdk.mjs");

    await expect(sdkTarballs(fixture)).rejects.toThrow(/size is unsafe/u);
  });

  it("replaces tarballs through a fresh exclusive temporary file", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "homey-vendor-test-"));
    fixtures.push(fixture);
    const source = join(fixture, "source.tgz");
    const destination = join(fixture, "destination.tgz");
    const temporary = join(fixture, "transaction.tmp");
    await writeFile(source, "reviewed archive\n");
    await writeFile(destination, "old archive\n");
    const replaceTarball = await loadReplaceTarball();

    await replaceTarball(source, destination, temporary);

    await expect(readFile(destination, "utf8")).resolves.toBe(
      "reviewed archive\n",
    );
  });

  it("refuses a precreated linked temporary file", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "homey-vendor-link-test-"));
    fixtures.push(fixture);
    const source = join(fixture, "source.tgz");
    const destination = join(fixture, "destination.tgz");
    const temporary = join(fixture, "transaction.tmp");
    const sentinel = join(fixture, "sentinel");
    await writeFile(source, "reviewed archive\n");
    await writeFile(destination, "old archive\n");
    await writeFile(sentinel, "preserve me\n");
    await symlink(sentinel, temporary);
    const replaceTarball = await loadReplaceTarball();

    await expect(
      replaceTarball(source, destination, temporary),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(destination, "utf8")).resolves.toBe("old archive\n");
    await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve me\n");
  });

  it.skipIf(process.platform === "win32")(
    "terminates inherited vendoring descendants after a timeout",
    async () => {
      const fixture = await mkdtemp(join(tmpdir(), "homey-vendor-group-test-"));
      fixtures.push(fixture);
      const leakedFile = join(fixture, "descendant-survived");
      const descendant = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(leakedFile)}, "leaked"), 250)`;
      const parent = `require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "inherit" }); setInterval(() => {}, 1000)`;
      const vendorModule =
        (await import("../scripts/vendor-homey-sdk.mjs")) as unknown as {
          runCommand(
            command: string,
            arguments_: string[],
            cwd: string,
            options: { timeoutMs: number; killGraceMs: number },
          ): Promise<void>;
        };

      await expect(
        vendorModule.runCommand(
          process.execPath,
          ["-e", parent],
          process.cwd(),
          {
            timeoutMs: 50,
            killGraceMs: 50,
          },
        ),
      ).rejects.toThrow(/timed out/u);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 350));
      await expect(access(leakedFile)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("runs vendoring commands with a reviewed environment", async () => {
    const vendorModule =
      (await import("../scripts/vendor-homey-sdk.mjs")) as unknown as {
        runCommand(
          command: string,
          arguments_: string[],
          cwd: string,
          options: { timeoutMs: number; killGraceMs: number },
        ): Promise<void>;
      };
    const previousPassword = process.env.CRADLEWISE_PASSWORD;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    process.env.CRADLEWISE_PASSWORD = "blocked-account-secret";
    process.env.NODE_OPTIONS = "--no-warnings";
    try {
      await expect(
        vendorModule.runCommand(
          process.execPath,
          [
            "-e",
            "if (process.env.CRADLEWISE_PASSWORD || process.env.NODE_OPTIONS) process.exit(7)",
          ],
          process.cwd(),
          { timeoutMs: 1_000, killGraceMs: 50 },
        ),
      ).resolves.toBeUndefined();
    } finally {
      if (previousPassword === undefined) {
        delete process.env.CRADLEWISE_PASSWORD;
      } else {
        process.env.CRADLEWISE_PASSWORD = previousPassword;
      }
      if (previousNodeOptions === undefined) {
        delete process.env.NODE_OPTIONS;
      } else {
        process.env.NODE_OPTIONS = previousNodeOptions;
      }
    }
  });
});
