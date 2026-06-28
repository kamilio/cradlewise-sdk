import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/version.js";

describe("package metadata", () => {
  it("keeps live integration failures secret-safe", async () => {
    const integration = await readFile("scripts/integration-test.ts", "utf8");
    expect(integration).toContain(
      'throw new Error("Cradlewise integration test failed.")',
    );
    expect(integration).toContain("await runIntegrationTest().catch(() => {");
    expect(integration).toContain("await Promise.allSettled([");
    expect(integration).toContain("complete live status");
  });

  it("keeps credentials and Android research artifacts out of builds", async () => {
    const [gitignore, homeyignore] = await Promise.all([
      readFile(".gitignore", "utf8"),
      readFile("packages/homey-app/.homeyignore", "utf8"),
    ]);
    expect(gitignore.split(/\r?\n/u)).toContain("env.json");
    expect(homeyignore.split(/\r?\n/u)).toContain("env.json");
    expect(gitignore).toContain(".env.*");
    expect(homeyignore).toContain(".env*");
    for (const path of [
      ".netrc",
      ".DS_Store",
      "._*",
      ".aws",
      ".gnupg",
      ".ssh",
      "__MACOSX",
      "id_dsa",
      "id_ecdsa",
      "id_ed25519",
      "id_rsa",
    ]) {
      expect(homeyignore.split(/\r?\n/u)).toContain(path);
    }
    for (const path of [
      ".netrc",
      ".npmrc",
      ".DS_Store",
      "._*",
      ".aws/",
      ".gnupg/",
      ".ssh/",
      "__MACOSX/",
      "id_dsa",
      "id_ecdsa",
      "id_ed25519",
      "id_rsa",
    ]) {
      expect(gitignore.split(/\r?\n/u)).toContain(path);
    }
    for (const path of [
      "*.apk",
      "*.APK",
      "*.aab",
      "*.AAB",
      "*.apks",
      "*.APKS",
      "*.xapk",
      "*.XAPK",
      "*.dex",
      "*.DEX",
      "*.[Aa][Pp][Kk]",
      "*.[Aa][Aa][Bb]",
      "*.[Aa][Pp][Kk][Ss]",
      "*.[Xx][Aa][Pp][Kk]",
      "*.[Dd][Ee][Xx]",
      "jadx-output/",
      "[Jj][Aa][Dd][Xx]-[Oo][Uu][Tt][Pp][Uu][Tt]/",
      "[Jj][Aa][Dd][Xx]/",
    ]) {
      expect(gitignore.split(/\r?\n/u)).toContain(path);
    }
    for (const path of [
      "*.apk",
      "*.APK",
      "*.aab",
      "*.AAB",
      "*.apks",
      "*.APKS",
      "*.xapk",
      "*.XAPK",
      "*.dex",
      "*.DEX",
      "*.[Aa][Pp][Kk]",
      "*.[Aa][Aa][Bb]",
      "*.[Aa][Pp][Kk][Ss]",
      "*.[Xx][Aa][Pp][Kk]",
      "*.[Dd][Ee][Xx]",
      "jadx-output",
      "[Jj][Aa][Dd][Xx]-[Oo][Uu][Tt][Pp][Uu][Tt]",
    ]) {
      expect(homeyignore.split(/\r?\n/u)).toContain(path);
    }
  });

  it("keeps runtime identity synchronized with package.json", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8")) as {
      name: string;
      version: string;
      type: string;
      engines: { node: string };
      bin: Record<string, string>;
      scripts: Record<string, string>;
      homepage: string;
      bugs: { url: string };
      repository: { type: string; url: string };
      files: string[];
      dependencies: Record<string, string>;
      optionalDependencies: Record<string, string>;
      exports: Record<string, unknown>;
      peerDependencies: Record<string, string>;
      peerDependenciesMeta: Record<string, { optional?: boolean }>;
      publishConfig: { access: string; provenance: boolean };
    };
    const lockfile = JSON.parse(
      await readFile("package-lock.json", "utf8"),
    ) as {
      packages: Record<string, { version?: string }>;
    };
    expect(PACKAGE_NAME).toBe(packageJson.name);
    expect(PACKAGE_VERSION).toBe(packageJson.version);
    expect(packageJson.type).toBe("module");
    expect(packageJson.engines.node).toBe(">=20.12");
    expect(packageJson.bin).toEqual({ cradlewise: "dist/cli.js" });
    expect(packageJson.publishConfig).toEqual({
      access: "public",
      provenance: true,
    });
    expect(packageJson.exports).toMatchObject({
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./toolcraft": {
        types: "./dist/toolcraft.d.ts",
        import: "./dist/toolcraft.js",
      },
      "./package.json": "./package.json",
    });
    expect(packageJson.peerDependencies).toHaveProperty(
      "aws-iot-device-sdk-v2",
    );
    expect(packageJson.dependencies).not.toHaveProperty("toolcraft");
    expect(packageJson.optionalDependencies).toEqual({
      toolcraft: "0.0.87",
    });
    expect(
      packageJson.peerDependenciesMeta["aws-iot-device-sdk-v2"]?.optional,
    ).toBe(true);
    expect(packageJson.scripts.prepublishOnly).toContain("release:check");
    expect(packageJson.scripts.prepublishOnly).toContain("npm run check");
    expect(packageJson.scripts.clean).toBe("node scripts/clean.mjs");
    expect(packageJson.scripts.build).toBe(
      "node scripts/clean.mjs dist && tsc -p tsconfig.build.json && node scripts/finalize-build.mjs",
    );
    expect(packageJson.scripts.check).toContain("npm run pack:reproducible");
    expect(packageJson.scripts.check).toContain("npm run smoke:types");
    expect(packageJson.scripts["smoke:types"]).toBe(
      "node scripts/declaration-smoke.mjs",
    );
    expect(packageJson.scripts["pack:reproducible"]).toBe(
      "node scripts/reproducible-pack.mjs",
    );
    expect(packageJson.scripts.prepack).toBeUndefined();
    expect(packageJson.scripts.postpack).toBeUndefined();
    expect(packageJson.scripts.prepare).toBeUndefined();
    expect(packageJson.scripts.preinstall).toBeUndefined();
    expect(packageJson.scripts.install).toBeUndefined();
    expect(packageJson.scripts.postinstall).toBeUndefined();
    expect(packageJson.homepage).toBe(
      "https://github.com/kjopek/cradlewise-js#readme",
    );
    expect(packageJson.bugs.url).toBe(
      "https://github.com/kjopek/cradlewise-js/issues",
    );
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/kjopek/cradlewise-js.git",
    });
    expect(packageJson.files).toContain("SECURITY.md");
    for (const [name, version] of Object.entries(packageJson.dependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(lockfile.packages[`node_modules/${name}`]?.version).toBe(version);
    }
    for (const [name, version] of Object.entries(
      packageJson.optionalDependencies,
    )) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(lockfile.packages[`node_modules/${name}`]?.version).toBe(version);
    }
  });

  it("locks runtime and development packages to immutable reviewed sources", async () => {
    for (const path of [
      "package-lock.json",
      "packages/homey-app/package-lock.json",
    ]) {
      const lockfile = JSON.parse(await readFile(path, "utf8")) as {
        packages: Record<
          string,
          {
            inBundle?: boolean;
            integrity?: string;
            link?: boolean;
            resolved?: string;
          }
        >;
      };
      for (const [packagePath, metadata] of Object.entries(lockfile.packages)) {
        if (!packagePath || metadata.link === true) continue;
        if (metadata.inBundle === true) {
          expect(packagePath).toMatch(
            /^node_modules\/toolcraft\/node_modules\//u,
          );
          continue;
        }
        if (
          path === "packages/homey-app/package-lock.json" &&
          packagePath === "node_modules/cradlewise"
        ) {
          expect(metadata.resolved).toBe("file:vendor/cradlewise-0.1.0.tgz");
        } else {
          expect(metadata.resolved).toMatch(
            /^https:\/\/registry\.npmjs\.org\//u,
          );
        }
        expect(metadata.integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/u);
      }
    }
  });
});
