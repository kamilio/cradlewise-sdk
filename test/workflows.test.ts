import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub workflows", () => {
  it("pins CI actions and tests the minimum Node runtime", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain(
      'node-version: ["20.12.2", "22.22.0", "24.14.0"]',
    );
    expect(workflow.match(/node-version: 24\.14\.0/g)).toHaveLength(2);
    expect(workflow.match(/node-version: 22\.22\.0/g)).toHaveLength(1);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).toContain("timeout-minutes: 20");
    expect(workflow.match(/runs-on: ubuntu-24\.04/g)).toHaveLength(3);
    expect(workflow).not.toContain("ubuntu-latest");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("cancel-in-progress: true");
    expect(workflow).toContain("npm ci --ignore-scripts");
    expect(workflow).toContain("npm audit signatures --omit=optional");
    expect(workflow).toContain("working-directory: packages/homey-app");
    expect(workflow).toContain(
      "npm run homey:vendor\n      - run: npm ci --ignore-scripts --prefix packages/homey-app\n      - run: npm run build --prefix packages/homey-app",
    );
    expect(workflow).toContain(
      'node packages/homey-app/scripts/prepare-homey-stage.mjs "$RUNNER_TEMP/cradlewise-homey-stage"',
    );
    expect(workflow).toContain(
      'node packages/homey-app/scripts/verify-prepared-homey-stage.mjs "$RUNNER_TEMP/cradlewise-homey-stage"',
    );
    expectContactFreeHomeyWorkflow(workflow);
    expectUnchangingActionPins(workflow);
  });

  it("keeps release publishing fail-closed", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("timeout-minutes: 30");
    expect(workflow.match(/runs-on: ubuntu-24\.04/g)).toHaveLength(1);
    expect(workflow).not.toContain("ubuntu-latest");
    expect(workflow).toContain("fetch-depth: 0");
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain(
      'test "$GITHUB_REPOSITORY" = "kjopek/cradlewise-js"',
    );
    expect(workflow).toContain(
      'git merge-base --is-ancestor "$GITHUB_SHA" origin/main',
    );
    expect(
      workflow.match(/npm pack npm@11\.18\.0 --ignore-scripts --silent/g),
    ).toHaveLength(2);
    expect(
      workflow.match(
        /sha512-T67M4L5wNm0cZ7EBLErcEkY1SmzEW\/WJ\+SADBzsFUY1UdAPfFHXFQtZ6SEXiK0\+vzXysCvAsepbMaBTwnrAD\+w==/g,
      ),
    ).toHaveLength(2);
    expect(workflow.match(/scripts\/verify-file-sri\.mjs/g)).toHaveLength(2);
    expect(workflow).toContain(
      'npm install --global "$NPM_CLI_DIR/$TARBALL" --ignore-scripts',
    );
    expect(workflow).toContain('test "$(npm --version)" = "11.18.0"');
    expect(workflow).toContain("Verify first-publish authentication");
    expect(workflow).toContain("Detect first publish");
    expect(workflow).toContain("npm view cradlewise version --json");
    expect(workflow).toContain('value?.error?.code === "E404"');
    expect(workflow).toContain(
      "Unable to determine whether the npm package already exists",
    );
    expect(workflow).toContain("steps.package-status.outputs.exists == 'true'");
    expect(workflow).toContain("steps.package-status.outputs.exists != 'true'");
    expect(workflow).toContain(
      "NPM_TOKEN is required for the first publish before trusted publishing can be configured",
    );
    expect(workflow).toContain("package-manager-cache: false");
    expect(workflow.match(/node-version: 24\.14\.0/g)).toHaveLength(2);
    expect(workflow.match(/node-version: 22\.22\.0/g)).toHaveLength(1);
    expect(workflow).toContain("npm ci --ignore-scripts");
    expect(workflow).toContain("npm audit signatures --omit=optional");
    expect(workflow).toContain("working-directory: packages/homey-app");
    expect(workflow).toContain(
      "npm run release:check\n      - run: npm run check",
    );
    expect(workflow).toContain(
      'node packages/homey-app/scripts/prepare-homey-stage.mjs "$RUNNER_TEMP/cradlewise-homey-stage"',
    );
    expect(workflow).toContain(
      'node packages/homey-app/scripts/verify-prepared-homey-stage.mjs "$RUNNER_TEMP/cradlewise-homey-stage"',
    );
    expect(workflow).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(workflow).toContain(
      'TARBALL="$(npm pack --ignore-scripts --silent)"',
    );
    expect(workflow).toContain('sha256sum "$TARBALL"');
    expect(workflow).toContain("Publish with trusted publishing");
    expect(workflow).toContain("Publish first release with token");
    expect(workflow).toContain(
      'npm publish "${{ steps.artifact.outputs.tarball }}" --ignore-scripts --provenance --access public',
    );
    expectContactFreeHomeyWorkflow(workflow);
    expectUnchangingActionPins(workflow);
  });
});

function expectContactFreeHomeyWorkflow(workflow: string): void {
  expect(workflow).not.toMatch(
    /\bhomey(?:\s+app)?\s+(?:install|login|publish|run|select)\b|test:live/u,
  );
}

function expectUnchangingActionPins(workflow: string): void {
  const uses = [...workflow.matchAll(/uses:\s+([^\s#]+)/g)].map(
    (match) => match[1]!,
  );
  expect(uses.length).toBeGreaterThan(0);
  for (const action of uses) {
    expect(action).toMatch(/^[^@]+@[0-9a-f]{40}$/);
  }
}
