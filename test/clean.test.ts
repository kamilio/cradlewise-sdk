import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const cleanScript = fileURLToPath(
  new URL("../scripts/clean.mjs", import.meta.url),
);

describe("clean script", () => {
  it("refuses paths outside known generated artifacts", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cradlewise-clean-test-"));
    const workspace = join(parent, "workspace");
    const sentinel = join(parent, "sentinel.txt");
    await writeFile(sentinel, "keep");
    await mkdir(workspace, { recursive: true });
    try {
      for (const unsafePath of [
        "../sentinel.txt",
        "C:sentinel.tgz",
        ".hidden.tgz",
      ]) {
        const result = spawnSync(process.execPath, [cleanScript, unsafePath], {
          cwd: workspace,
          encoding: "utf8",
        });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("Refusing to remove unsupported path");
      }
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });

  it("removes only supported local artifacts", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cradlewise-clean-test-"));
    const tarball = join(workspace, "cradlewise-0.1.0.tgz");
    await writeFile(tarball, "generated");
    try {
      const result = spawnSync(
        process.execPath,
        [cleanScript, "cradlewise-0.1.0.tgz"],
        { cwd: workspace, encoding: "utf8" },
      );
      expect(result.status).toBe(0);
      await expect(readFile(tarball, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("never recursively removes directories named like archives", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cradlewise-clean-test-"));
    const archiveDirectory = join(workspace, "important.tgz");
    const sentinel = join(archiveDirectory, "sentinel.txt");
    await mkdir(archiveDirectory);
    await writeFile(sentinel, "keep");
    try {
      const result = spawnSync(process.execPath, [cleanScript], {
        cwd: workspace,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(await readFile(sentinel, "utf8")).toBe("keep");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("preflights every archive before removing any artifact", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "cradlewise-clean-test-"));
    const distSentinel = join(workspace, "dist", "sentinel.txt");
    const archiveSentinel = join(workspace, "important.tgz", "sentinel.txt");
    await mkdir(join(workspace, "dist"));
    await mkdir(join(workspace, "important.tgz"));
    await writeFile(distSentinel, "keep");
    await writeFile(archiveSentinel, "keep");
    try {
      const result = spawnSync(process.execPath, [cleanScript], {
        cwd: workspace,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(await readFile(distSentinel, "utf8")).toBe("keep");
      expect(await readFile(archiveSentinel, "utf8")).toBe("keep");
    } finally {
      await rm(workspace, { force: true, recursive: true });
    }
  });

  it("removes a symlinked build directory without following it", async () => {
    const parent = await mkdtemp(join(tmpdir(), "cradlewise-clean-test-"));
    const workspace = join(parent, "workspace");
    const external = join(parent, "external");
    const sentinel = join(external, "sentinel.txt");
    await mkdir(workspace);
    await mkdir(external);
    await writeFile(sentinel, "keep");
    await symlink(external, join(workspace, "dist"));
    try {
      const result = spawnSync(process.execPath, [cleanScript, "dist"], {
        cwd: workspace,
        encoding: "utf8",
      });
      expect(result.status).toBe(0);
      expect(await readFile(sentinel, "utf8")).toBe("keep");
      await expect(
        readFile(join(workspace, "dist"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(parent, { force: true, recursive: true });
    }
  });
});
