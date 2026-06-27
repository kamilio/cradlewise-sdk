import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isTrustedDiscoveredConfig,
  isTrustedDiscoveredIotEndpoint,
} from "../src/discovery-trust.js";

describe("auto-discovery trust fingerprint", () => {
  it("keeps Android research notes aligned with trust pins", () => {
    const source = readFileSync("src/discovery-trust.ts", "utf8");
    const notes = readFileSync("docs/android-bundle-notes.md", "utf8");
    const fingerprints = source.match(/\b[a-f0-9]{64}\b/gu) ?? [];

    expect(fingerprints).toHaveLength(2);
    for (const fingerprint of fingerprints)
      expect(notes).toContain(fingerprint);
  });

  it("rejects substituted authentication configuration", () => {
    const candidate = {
      cognitoUserPoolId: "us-east-1_substituted",
      cognitoAppClientId: "substituted-client",
      cognitoAppClientSecret: "substituted-secret",
      cognitoIdentityPoolId: "us-east-1:substituted",
      cognitoRegion: "us-east-1",
      apiBaseUrl: "https://backend.cradlewise.com/api",
    };
    expect(isTrustedDiscoveredConfig(candidate)).toBe(false);
    expect(
      isTrustedDiscoveredConfig({
        ...candidate,
        cognitoAppClientSecret: "different-secret",
      }),
    ).toBe(false);
    expect(
      isTrustedDiscoveredIotEndpoint(
        "substituted-ats.iot.us-east-1.amazonaws.com",
      ),
    ).toBe(false);
  });
});
