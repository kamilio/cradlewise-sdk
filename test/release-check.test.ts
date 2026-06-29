import { spawnSync } from "node:child_process";
import {
  link,
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

const releaseCheck = fileURLToPath(
  new URL("../scripts/release-check.mjs", import.meta.url),
);
const reviewedToolcraftBundles = [
  "toolcraft-schema",
  "toolcraft-design",
  "@poe-code/frontmatter",
  "@poe-code/agent-mcp-config",
  "@poe-code/agent-human-in-loop",
  "@poe-code/task-list",
  "@poe-code/agent-defs",
  "@poe-code/config-mutations",
  "@poe-code/process-runner",
  "tiny-mcp-client",
  "tiny-stdio-mcp-server",
  "auth-store",
] as const;
const reviewedToolcraftVersion = "0.0.109";
const reviewedToolcraftIntegrity =
  "sha512-dDglsvnwTxMZ91NJzZvCV7lg1LgP67E5M3h/yHWggAEVHUDCsegg1/zwSUAuVv09dVaPHhMAlybeumHZNaI7Ag==";

describe("release dependency license check", () => {
  it("accepts licensed packages and declared bundled internals", async () => {
    const directory = await createFixture();
    try {
      const result = runReleaseCheck(directory);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("installation/license checks passed");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects independent or undeclared unlicensed packages", async () => {
    const directory = await createFixture({ includeFailure: true });
    try {
      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("unlicensed-independent@1.0.0");
      expect(result.stderr).toContain("notice-only@1.0.0");
      expect(result.stderr).toContain("empty-license@1.0.0");
      expect(result.stderr).toContain("linked-license@1.0.0");
      expect(result.stderr).toContain("proprietary-label@1.0.0");
      expect(result.stderr).toContain("undeclared-private@1.0.0");
      expect(result.stderr).toContain(
        "expected=mismatched@1.0.0 installed=mismatched@2.0.0",
      );
      expect(result.stderr).toContain(
        "production package declares an install script",
      );
      expect(result.stderr).not.toMatch(
        /(?:terms: |, )toolcraft-design@1\.0\.0/,
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects bundled internals from an unreviewed parent archive", async () => {
    const directory = await createFixture();
    try {
      const lockPath = join(directory, "package-lock.json");
      const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
      lockfile.packages["node_modules/toolcraft"].integrity =
        "sha512-unreviewed";
      await writeFile(lockPath, JSON.stringify(lockfile));

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("toolcraft-design@1.0.0");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects reviewed parents with changed bundle membership", async () => {
    const directory = await createFixture();
    try {
      const packagePath = join(
        directory,
        "node_modules/toolcraft/package.json",
      );
      const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
      packageJson.bundleDependencies = [
        ...packageJson.bundleDependencies,
        "new-licensed-child",
      ];
      await writeFile(packagePath, JSON.stringify(packageJson));

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "unexpected integrity, composition, or membership",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects bundled package drift from the published composition", async () => {
    const directory = await createFixture();
    try {
      const compositionPath = join(
        directory,
        "node_modules/toolcraft/dist/composition.json",
      );
      const composition = JSON.parse(
        await readFile(compositionPath, "utf8"),
      ) as {
        packages: Array<{ name: string; version: string }>;
      };
      const schemaPackage = composition.packages.find(
        ({ name }) => name === "toolcraft-schema",
      );
      if (!schemaPackage) throw new Error("Fixture schema package is missing");
      schemaPackage.version = "9.9.9";
      await writeFile(compositionPath, JSON.stringify(composition));

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "unexpected integrity, composition, or membership",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects non-registry or missing-integrity production sources", async () => {
    const directory = await createFixture();
    try {
      const lockPath = join(directory, "package-lock.json");
      const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
      lockfile.packages["node_modules/licensed"].resolved =
        "git+https://example.com/licensed.git#main";
      delete lockfile.packages["node_modules/referenced-license"].integrity;
      await writeFile(lockPath, JSON.stringify(lockfile));

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "production package lacks an official npm registry source and SHA-512 integrity",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects symlinked production package directories", async () => {
    const directory = await createFixture();
    try {
      const realPackage = join(directory, "real-package");
      await writePackage(directory, "real-package", {
        name: "symlinked",
        version: "1.0.0",
        license: "MIT",
      });
      await symlink(realPackage, join(directory, "node_modules/symlinked"));
      const lockPath = join(directory, "package-lock.json");
      const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
      lockfile.packages["node_modules/symlinked"] = { version: "1.0.0" };
      await writeFile(lockPath, JSON.stringify(lockfile));

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "production package path is not a real directory",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects production packages beneath symlinked directories", async () => {
    const directory = await createFixture();
    try {
      const externalScope = join(directory, "external-scope");
      await writePackage(directory, "external-scope/package", {
        name: "@scope/package",
        version: "1.0.0",
        license: "MIT",
      });
      await symlink(externalScope, join(directory, "node_modules/@scope"));
      const lockPath = join(directory, "package-lock.json");
      const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
      lockfile.packages["node_modules/@scope/package"] = { version: "1.0.0" };
      await writeFile(lockPath, JSON.stringify(lockfile));

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "production package path is not a real directory",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("accepts npm bundled metadata deduped to an exact ancestor package", async () => {
    const directory = await createFixture();
    try {
      const deduped = lockPackage("deduped", "1.0.0");
      await writePackage(directory, "node_modules/deduped", {
        name: "deduped",
        version: "1.0.0",
        license: "MIT",
      });
      const lockPath = join(directory, "package-lock.json");
      const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
      lockfile.packages["node_modules/deduped"] = deduped;
      lockfile.packages["node_modules/toolcraft/node_modules/deduped"] = {
        ...deduped,
        inBundle: true,
      };
      await writeFile(lockPath, JSON.stringify(lockfile));

      const result = runReleaseCheck(directory);
      expect(result.status).toBe(0);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects bundled metadata without an exact locked ancestor package", async () => {
    const directory = await createFixture();
    try {
      const lockPath = join(directory, "package-lock.json");
      const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
      lockfile.packages["node_modules/toolcraft/node_modules/deduped"] = {
        ...lockPackage("deduped", "1.0.0"),
        inBundle: true,
      };
      await writeFile(lockPath, JSON.stringify(lockfile));

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "production package path is not a real directory",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects symlinked package manifests", async () => {
    const directory = await createFixture();
    try {
      const packagePath = join(directory, "node_modules/licensed/package.json");
      const externalManifest = join(directory, "external-package.json");
      await writeFile(
        externalManifest,
        JSON.stringify({ name: "licensed", version: "1.0.0", license: "MIT" }),
      );
      await rm(packagePath);
      await symlink(externalManifest, packagePath);

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "package.json is not a safe regular file",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects hard-linked package manifests", async () => {
    const directory = await createFixture();
    try {
      const packagePath = join(directory, "node_modules/licensed/package.json");
      const externalManifest = join(directory, "external-package.json");
      await writeFile(
        externalManifest,
        JSON.stringify({ name: "licensed", version: "1.0.0", license: "MIT" }),
      );
      await rm(packagePath);
      await link(externalManifest, packagePath);

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "package.json is not a safe regular file",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects unsupported or malformed lockfile schemas", async () => {
    const directory = await createFixture();
    try {
      const lockPath = join(directory, "package-lock.json");
      const lockfile = JSON.parse(await readFile(lockPath, "utf8"));

      await writeFile(
        lockPath,
        JSON.stringify({ ...lockfile, lockfileVersion: 2 }),
      );
      let result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("version 3 lockfile");

      await writeFile(lockPath, JSON.stringify({ ...lockfile, packages: [] }));
      result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("version 3 lockfile");

      lockfile.packages["node_modules/licensed"] = "invalid";
      await writeFile(lockPath, JSON.stringify(lockfile));
      result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid lock metadata");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects root install scripts", async () => {
    const directory = await createFixture();
    try {
      const lockPath = join(directory, "package-lock.json");
      const lockfile = JSON.parse(await readFile(lockPath, "utf8"));
      lockfile.packages[""].hasInstallScript = true;
      await writeFile(lockPath, JSON.stringify(lockfile));

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "package root: package declares an install script",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects packages whose declared name does not match their path", async () => {
    const directory = await createFixture();
    try {
      const packagePath = join(directory, "node_modules/licensed/package.json");
      await writeFile(
        packagePath,
        JSON.stringify({
          name: "different-package",
          version: "1.0.0",
          license: "MIT",
        }),
      );

      const result = runReleaseCheck(directory);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "expected=licensed@1.0.0 installed=different-package@1.0.0",
      );
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

async function createFixture(
  options: { includeFailure?: boolean } = {},
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "cradlewise-release-check-"));
  const packages: Record<string, Record<string, unknown>> = {
    "": { name: "fixture", version: "1.0.0", license: "MIT" },
    "node_modules/licensed": lockPackage("licensed", "1.0.0"),
    "node_modules/toolcraft": {
      ...lockPackage("toolcraft", reviewedToolcraftVersion),
      integrity: reviewedToolcraftIntegrity,
    },
  };
  await writePackage(directory, "node_modules/licensed", {
    name: "licensed",
    version: "1.0.0",
    license: "MIT",
  });
  await writeFile(
    join(directory, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0", license: "MIT" }),
  );
  await writePackage(directory, "node_modules/referenced-license", {
    name: "referenced-license",
    version: "1.0.0",
    license: "SEE LICENSE IN TERMS.txt",
  });
  await writeFile(
    join(directory, "node_modules/referenced-license/TERMS.txt"),
    "Permission granted",
  );
  packages["node_modules/referenced-license"] = lockPackage(
    "referenced-license",
    "1.0.0",
  );
  await writePackage(directory, "node_modules/toolcraft", {
    name: "toolcraft",
    version: reviewedToolcraftVersion,
    license: "MIT",
    bundleDependencies: [...reviewedToolcraftBundles],
  });
  await mkdir(join(directory, "node_modules/toolcraft/dist"), {
    recursive: true,
  });
  await writeFile(
    join(directory, "node_modules/toolcraft/dist/composition.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: [
        {
          name: "toolcraft",
          version: reviewedToolcraftVersion,
          license: "MIT",
        },
        ...reviewedToolcraftBundles.map((name) => ({
          name,
          version: "1.0.0",
          license: "MIT",
        })),
      ],
    }),
  );
  for (const packageName of reviewedToolcraftBundles) {
    const packageDirectory = `node_modules/toolcraft/node_modules/${packageName}`;
    packages[packageDirectory] = { version: "1.0.0", inBundle: true };
    await writePackage(directory, packageDirectory, {
      name: packageName,
      version: "1.0.0",
      private: true,
    });
  }
  if (options.includeFailure) {
    packages["node_modules/mismatched"] = { version: "1.0.0" };
    packages["node_modules/install-script"] = {
      version: "1.0.0",
      hasInstallScript: true,
    };
    packages["node_modules/unlicensed-independent"] = { version: "1.0.0" };
    packages["node_modules/notice-only"] = { version: "1.0.0" };
    packages["node_modules/empty-license"] = { version: "1.0.0" };
    packages["node_modules/linked-license"] = { version: "1.0.0" };
    packages["node_modules/proprietary-label"] = { version: "1.0.0" };
    packages["node_modules/toolcraft/node_modules/undeclared-private"] = {
      version: "1.0.0",
      inBundle: true,
    };
    await writePackage(directory, "node_modules/unlicensed-independent", {
      name: "unlicensed-independent",
      version: "1.0.0",
    });
    await writePackage(directory, "node_modules/notice-only", {
      name: "notice-only",
      version: "1.0.0",
    });
    await writeFile(
      join(directory, "node_modules/notice-only/NOTICE"),
      "Attribution only",
    );
    await writePackage(directory, "node_modules/empty-license", {
      name: "empty-license",
      version: "1.0.0",
    });
    await writeFile(join(directory, "node_modules/empty-license/LICENSE"), "");
    await writePackage(directory, "node_modules/linked-license", {
      name: "linked-license",
      version: "1.0.0",
    });
    await writeFile(join(directory, "BORROWED-LICENSE"), "Permission granted");
    await symlink(
      join(directory, "BORROWED-LICENSE"),
      join(directory, "node_modules/linked-license/LICENSE"),
    );
    await writePackage(directory, "node_modules/proprietary-label", {
      name: "proprietary-label",
      version: "1.0.0",
      license: "Proprietary",
    });
    await writePackage(directory, "node_modules/mismatched", {
      name: "mismatched",
      version: "2.0.0",
      license: "MIT",
    });
    await writePackage(directory, "node_modules/install-script", {
      name: "install-script",
      version: "1.0.0",
      license: "MIT",
    });
    await writePackage(
      directory,
      "node_modules/toolcraft/node_modules/undeclared-private",
      {
        name: "undeclared-private",
        version: "1.0.0",
        private: true,
      },
    );
  }
  await writeFile(
    join(directory, "package-lock.json"),
    JSON.stringify({ lockfileVersion: 3, packages }),
  );
  return directory;
}

async function writePackage(
  root: string,
  directory: string,
  packageJson: Record<string, unknown>,
): Promise<void> {
  const target = join(root, directory);
  await mkdir(target, { recursive: true });
  await writeFile(join(target, "package.json"), JSON.stringify(packageJson));
}

function runReleaseCheck(directory: string) {
  return spawnSync(process.execPath, [releaseCheck], {
    cwd: directory,
    encoding: "utf8",
  });
}

function lockPackage(name: string, version: string): Record<string, unknown> {
  return {
    version,
    resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    integrity: "sha512-Zml4dHVyZQ==",
  };
}
