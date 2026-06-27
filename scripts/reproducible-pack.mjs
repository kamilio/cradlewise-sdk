import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories = await Promise.all([
  mkdtemp(join(tmpdir(), "cradlewise-pack-a-")),
  mkdtemp(join(tmpdir(), "cradlewise-pack-b-")),
]);
const MAX_TARBALL_BYTES = 64 * 1024 * 1024;

try {
  const hashes = [];
  for (const directory of directories) {
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    const packed = spawnSync(
      npm,
      ["pack", "--silent", "--pack-destination", directory],
      {
        encoding: "utf8",
        env: { ...process.env, npm_config_ignore_scripts: "true" },
        maxBuffer: 1024 * 1024,
        timeout: 120_000,
      },
    );
    if (packed.error || packed.status !== 0) {
      throw new Error(packed.stderr || packed.stdout || "npm pack failed");
    }
    const entries = (await readdir(directory)).filter((entry) =>
      entry.endsWith(".tgz"),
    );
    if (entries.length !== 1) {
      throw new Error("npm pack did not produce exactly one tarball");
    }
    const tarballPath = join(directory, entries[0]);
    const metadata = await lstat(tarballPath);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.nlink !== 1 ||
      metadata.size <= 0 ||
      metadata.size > MAX_TARBALL_BYTES
    ) {
      throw new Error("npm pack produced an unsafe tarball");
    }
    hashes.push(
      createHash("sha256")
        .update(await readFile(tarballPath))
        .digest("hex"),
    );
  }
  if (hashes[0] !== hashes[1]) {
    throw new Error("npm pack output is not byte-reproducible");
  }
  console.log(`Reproducible package SHA-256: ${hashes[0]}`);
} finally {
  await Promise.all(
    directories.map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
}
