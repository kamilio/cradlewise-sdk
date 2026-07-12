import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reviewedChildEnvironment } from "./child-environment.mjs";

const directory = await mkdtemp(join(tmpdir(), "cradlewise-types-"));
const root = process.cwd();

try {
  await writeFile(
    join(directory, "consumer.ts"),
    `import {
  AppConfig,
  CradlewiseClient,
  isTrustedDiscoveredAppConfig,
  type BabyProfile,
  type CradlePhoto,
  type CradleData,
  type CradlewiseApiErrorOptions,
  type InboxBooleanGroups,
  type InboxMessagesResponse,
  type InboxTagGroups,
  type InboxTextGroups,
} from "@kamilio/cradlewise-sdk";
import { cradlewiseToolcraftRoot } from "@kamilio/cradlewise-sdk/toolcraft";

declare const client: CradlewiseClient;
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
const deviceIds: Promise<string[]> = client.getUserDeviceIds("baby");
const inbox: Promise<InboxMessagesResponse> = client.getInboxMessages(
  "crib",
  "baby",
);
const redDots: InboxBooleanGroups = {
  baby_notifications: false,
  cradlewise_notifications: true,
};
const tags: InboxTagGroups = {
  baby_notifications: ["baby"],
  cradlewise_notifications: [],
};
const endMessages: InboxTextGroups = {
  baby_notifications: null,
  cradlewise_notifications: "End of notifications",
};
const photo: Promise<CradlePhoto | undefined> = client.getLatestCribPhoto(
  "crib",
  "baby",
);
void profile;
void cradle;
void options;
void deviceIds;
void inbox;
void redDots;
void tags;
void endMessages;
void photo;
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
              "@kamilio/cradlewise-sdk": [resolve(root, "dist/index.d.ts")],
              "@kamilio/cradlewise-sdk/toolcraft": [
                resolve(root, "dist/toolcraft.d.ts"),
              ],
              toolcraft: [
                resolve(root, "node_modules/toolcraft/dist/index.d.ts"),
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
      env: reviewedChildEnvironment(process.env),
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
