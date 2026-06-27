import { createHash } from "node:crypto";
import {
  link,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyFileSri } from "../scripts/verify-file-sri.mjs";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(
    fixtures
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("reviewed archive SRI verification", () => {
  it("accepts exact single-link archive bytes", async () => {
    const { archive, integrity } = await createArchive();
    await expect(verifyFileSri(archive, integrity)).resolves.toBeUndefined();
  });

  it("rejects mismatched or malformed integrity", async () => {
    const { archive } = await createArchive();
    await expect(
      verifyFileSri(
        archive,
        `sha512-${Buffer.from("different").toString("base64")}`,
      ),
    ).rejects.toThrow("integrity mismatch");
    await expect(verifyFileSri(archive, "sha256-invalid")).rejects.toThrow(
      "SHA-512 integrity is invalid",
    );
  });

  it("rejects linked archives", async () => {
    const { directory, archive, integrity } = await createArchive();
    const symbolic = join(directory, "symbolic.tgz");
    const hard = join(directory, "hard.tgz");
    await symlink(archive, symbolic);
    await link(archive, hard);
    await expect(verifyFileSri(symbolic, integrity)).rejects.toThrow(
      "safe regular file",
    );
    await expect(verifyFileSri(hard, integrity)).rejects.toThrow(
      "safe regular file",
    );
  });

  it("rejects oversized archives before reading", async () => {
    const { archive, integrity } = await createArchive();
    await truncate(archive, 64 * 1024 * 1024 + 1);
    await expect(verifyFileSri(archive, integrity)).rejects.toThrow(
      "safe regular file",
    );
  });
});

async function createArchive(): Promise<{
  archive: string;
  directory: string;
  integrity: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "reviewed-sri-test-"));
  fixtures.push(directory);
  const archive = join(directory, "archive.tgz");
  const contents = Buffer.from("reviewed archive bytes\n");
  await writeFile(archive, contents);
  return {
    archive,
    directory,
    integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,
  };
}
