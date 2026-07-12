#!/usr/bin/env node
import { runCLI } from "toolcraft/cli";
import { runMCP } from "toolcraft/mcp";
import { OAUTH_FLAG, prepareOAuthCLI } from "./cli-oauth.js";
import { cradlewiseToolcraftRoot } from "./toolcraft.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

if (process.argv[2] === "mcp") {
  await runMCP(cradlewiseToolcraftRoot, {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });
} else {
  let prepared: Awaited<ReturnType<typeof prepareOAuthCLI>> | undefined;
  try {
    prepared = await prepareOAuthCLI({
      argv: process.argv.slice(2),
      env: process.env,
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Unable to read Cradlewise credentials"}\n`,
    );
    process.exitCode = 1;
  }
  if (!prepared) process.exit();
  if (
    prepared.argv.length === 0 ||
    prepared.argv.some((argument) => argument === "--help" || argument === "-h")
  ) {
    process.stdout.write(
      `\n${OAUTH_FLAG}  Print a temporary LAN login URL and wait for account credentials\n`,
    );
  }
  await runCLI(cradlewiseToolcraftRoot, {
    argv: [
      process.argv[0] ?? "node",
      process.argv[1] ?? "cradlewise",
      ...prepared.argv,
    ],
    env: prepared.env,
    version: PACKAGE_VERSION,
    rootUsageName: PACKAGE_NAME,
    controls: { output: true },
  });
}
