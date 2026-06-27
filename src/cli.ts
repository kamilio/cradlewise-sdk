#!/usr/bin/env node
import { runCLI } from "toolcraft/cli";
import { runMCP } from "toolcraft/mcp";
import { cradlewiseToolcraftRoot } from "./toolcraft.js";
import { PACKAGE_NAME, PACKAGE_VERSION } from "./version.js";

if (process.argv[2] === "mcp") {
  await runMCP(cradlewiseToolcraftRoot, {
    name: PACKAGE_NAME,
    version: PACKAGE_VERSION,
  });
} else {
  await runCLI(cradlewiseToolcraftRoot, {
    version: PACKAGE_VERSION,
    rootUsageName: PACKAGE_NAME,
    controls: { output: true },
  });
}
