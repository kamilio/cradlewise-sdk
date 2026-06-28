import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isTrustedDiscoveredConfig,
  isTrustedDiscoveredIotEndpoint,
} from "../src/discovery-trust.js";

describe("Android bundle-derived contracts", () => {
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

  it("keeps Android inbox notes aligned with implemented fields", () => {
    const clientSource = readFileSync("src/client.ts", "utf8");
    const typesSource = readFileSync("src/types.ts", "utf8");
    const notes = readFileSync("docs/android-bundle-notes.md", "utf8");
    const queryBlock = clientSource.match(
      /async getInboxMessages[\s\S]*?query: \{([\s\S]*?)\n\s*\},\n\s*\}\);/u,
    )?.[1];
    const messageBlock = typesSource.match(
      /export interface InboxMessage extends JsonObject \{([\s\S]*?)\n\}/u,
    )?.[1];

    expect(queryBlock).toBeDefined();
    expect(messageBlock).toBeDefined();

    const queryFields = [...(queryBlock ?? "").matchAll(/^\s*([a-z_]+):/gmu)]
      .map((match) => match[1])
      .sort();
    const messageFields = [
      ...(messageBlock ?? "").matchAll(/^\s*([a-z_]+)\?:/gmu),
    ]
      .map((match) => match[1])
      .sort();

    expect(queryFields).toEqual(
      [
        "baby_id",
        "cradle_id",
        "device_id",
        "message_type",
        "page_size",
        "tags",
      ].sort(),
    );
    expect(messageFields).toEqual(
      [
        "aspect_ratio",
        "body",
        "button_text",
        "content_type",
        "content_url",
        "external_url",
        "is_read",
        "is_starred",
        "message_id",
        "message_time",
        "message_type",
        "notification_id",
        "presentation_image_url",
        "priority",
        "status",
        "thumbnail_url",
        "title",
      ].sort(),
    );
    for (const field of [...queryFields, ...messageFields])
      expect(notes).toContain(`- \`${field}\``);
  });
});
