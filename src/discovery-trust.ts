import { createHash } from "node:crypto";
import type { AppConfigData } from "./types.js";

const TRUSTED_DISCOVERED_CONFIG_SHA256 =
  "5314aee9b23b585706300d6b7d86ad6d74125c39772b21003ce953c2e5315413";
const TRUSTED_DISCOVERED_IOT_ENDPOINT_SHA256 =
  "bd1d018c23681cc4457abc1f288a1b37810e5157a31116b1798a2c5c5678ba75";

export function isTrustedDiscoveredConfig(config: AppConfigData): boolean {
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        config.cognitoUserPoolId,
        config.cognitoAppClientId,
        config.cognitoAppClientSecret,
        config.cognitoIdentityPoolId,
        config.cognitoRegion,
        config.apiBaseUrl,
      ]),
    )
    .digest("hex");
  return fingerprint === TRUSTED_DISCOVERED_CONFIG_SHA256;
}

export function isTrustedDiscoveredIotEndpoint(endpoint: string): boolean {
  return (
    createHash("sha256").update(endpoint).digest("hex") ===
    TRUSTED_DISCOVERED_IOT_ENDPOINT_SHA256
  );
}
