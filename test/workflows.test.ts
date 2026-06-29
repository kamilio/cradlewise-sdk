import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("GitHub workflows", () => {
  it("publishes stable packages with trusted provenance", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    expect(workflow).toContain("id-token: write");
    expect(workflow).toContain("npm@^11.15.0");
    expect(workflow).toContain("npm version --no-git-tag-version patch");
    expect(workflow).toContain(
      "npm publish --provenance --access public --tag latest",
    );
    expect(workflow).toContain('version.includes("-")');
    expect(workflow).not.toContain("NODE_AUTH_TOKEN");
    expect(workflow).not.toContain("NPM_TOKEN");
    expectPinnedActions(workflow);
  });

  it("runs checks on pull requests", async () => {
    const workflow = await readFile(".github/workflows/ci.yml", "utf8");
    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("npm run check");
    expectPinnedActions(workflow);
  });
});

function expectPinnedActions(workflow: string): void {
  const actions = [...workflow.matchAll(/uses:\s+([^\s#]+)/gu)].map(
    (match) => match[1],
  );
  expect(actions.length).toBeGreaterThan(0);
  for (const action of actions) expect(action).toMatch(/^[^@]+@[0-9a-f]{40}$/u);
}
