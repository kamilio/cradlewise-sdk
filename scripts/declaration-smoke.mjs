import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "cradlewise-types-"));
const root = process.cwd();

try {
  await writeFile(
    join(directory, "consumer.ts"),
    `import {
  AppConfig,
  CradlewiseRealtime,
  isTrustedDiscoveredAppConfig,
  type BabyProfile,
  type CradleData,
  type CradlewiseApiErrorOptions,
  type CradlewiseRealtimeEventMap,
} from "cradlewise";
import { cradlewiseToolcraftRoot } from "cradlewise/toolcraft";

declare const realtime: CradlewiseRealtime;
declare const appConfig: AppConfig;
const profile: BabyProfile = { baby_id: "baby" };
const cradle: CradleData = {
  cradleId: "crib",
  state: {},
  online: false,
  statusPartial: false,
  unavailableStatusSources: [],
};
const options: CradlewiseApiErrorOptions = { status: 503 };
const event: CradlewiseRealtimeEventMap["state"] = ["crib", {}, "topic"];
realtime.on("state", (cradleId, state, topic) => {
  cradleId.toUpperCase();
  Object.keys(state);
  topic.toUpperCase();
});
realtime.on("error", (error) => error.message);
// @ts-expect-error unknown realtime event
realtime.on("unknown", () => undefined);
void profile;
void cradle;
void options;
void event;
void isTrustedDiscoveredAppConfig(appConfig);
void cradlewiseToolcraftRoot;
`,
  );
  const tsc = process.platform === "win32" ? "tsc.cmd" : "tsc";
  for (const exactOptionalPropertyTypes of [false, true]) {
    await writeFile(
      join(directory, "tsconfig.json"),
      `${JSON.stringify(
        {
          compilerOptions: {
            target: "ES2022",
            lib: ["ES2022"],
            module: "NodeNext",
            moduleResolution: "NodeNext",
            strict: true,
            exactOptionalPropertyTypes,
            skipLibCheck: false,
            types: ["node"],
            noEmit: true,
            baseUrl: directory,
            paths: {
              cradlewise: [resolve(root, "dist/index.d.ts")],
              "cradlewise/toolcraft": [resolve(root, "dist/toolcraft.d.ts")],
              toolcraft: [
                resolve(root, "node_modules/toolcraft/dist/index.d.ts"),
              ],
              "toolcraft-schema": [
                resolve(root, "node_modules/toolcraft-schema/dist/index.d.ts"),
              ],
            },
            typeRoots: [resolve(root, "node_modules/@types")],
          },
          include: ["consumer.ts"],
        },
        null,
        2,
      )}\n`,
    );
    const checked = spawnSync(tsc, ["-p", join(directory, "tsconfig.json")], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
    });
    if (checked.error || checked.status !== 0) {
      throw new Error(
        checked.stderr ||
          checked.stdout ||
          `Declaration smoke test failed with exactOptionalPropertyTypes=${String(exactOptionalPropertyTypes)}`,
      );
    }
  }
  console.log("Consumer declaration smoke tests passed");
} finally {
  await rm(directory, { force: true, recursive: true });
}
