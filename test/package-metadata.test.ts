import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PACKAGE_NAME, PACKAGE_VERSION } from "../src/version.js";

describe("package metadata", () => {
  it("keeps runtime identity synchronized with package.json", async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const lockfile = JSON.parse(await readFile("package-lock.json", "utf8"));

    expect(PACKAGE_NAME).toBe("@kamilio/cradlewise-sdk");
    expect(PACKAGE_NAME).toBe(packageJson.name);
    expect(PACKAGE_VERSION).toBe(packageJson.version);
    expect(lockfile.name).toBe(packageJson.name);
    expect(lockfile.packages[""].name).toBe(packageJson.name);
    expect(packageJson.repository).toEqual({
      type: "git",
      url: "git+https://github.com/kamilio/cradlewise-sdk.git",
    });
    expect(packageJson.publishConfig).toEqual({
      access: "public",
    });
    expect(packageJson.scripts).not.toHaveProperty("homey:install");
    expect(packageJson.scripts).not.toHaveProperty("homey:vendor");
  });

  it("keeps credentials out of Git", async () => {
    const gitignore = await readFile(".gitignore", "utf8");
    for (const path of [
      ".env.*",
      ".npmrc",
      ".netrc",
      ".aws/",
      ".gnupg/",
      ".ssh/",
    ]) {
      expect(gitignore).toContain(path);
    }
  });

  it("keeps live integration failures secret-safe", async () => {
    const integration = await readFile("scripts/integration-test.ts", "utf8");
    expect(integration).toContain(
      'throw new Error("Cradlewise integration test failed.")',
    );
    expect(integration).toContain("await runIntegrationTest().catch(() => {");
  });
});
