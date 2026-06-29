import {
  defineCommand,
  defineGroup,
  defineStreamCommand,
  S,
  type Static,
  UserError,
} from "toolcraft";
import { CradlewiseAuth } from "./auth.js";
import { CradlewiseClient, formatApiDate } from "./client.js";
import { CradlewiseController } from "./controls.js";
import { getAppConfig, refreshAppConfig } from "./config.js";
import type { Cradle } from "./models.js";
import type { CradleData } from "./models.js";
import { utf8ByteLength } from "./text-utils.js";

const MAX_TOOL_RESULT_NODES = 1_000_000;
const MAX_TOOL_RESULT_TEXT_BYTES = 16 * 1024 * 1024;
const DEFAULT_WATCH_INTERVAL_SECONDS = 30;
const MIN_WATCH_INTERVAL_SECONDS = 15;
const MAX_WATCH_INTERVAL_SECONDS = 300;

const secrets = {
  email: {
    env: "CRADLEWISE_LOGIN",
    description: "Email address for the Cradlewise account",
  },
  password: {
    env: "CRADLEWISE_PASSWORD",
    description: "Password for the Cradlewise account",
  },
} as const;

const cradleResult = S.Object({
  cradleId: S.String(),
  babyId: S.Optional(S.String()),
  babyName: S.Optional(S.String()),
  firmwareVersion: S.Optional(S.String()),
  timezone: S.Optional(S.String()),
  serialNumber: S.Optional(S.String()),
  state: S.Json(),
  online: S.Boolean(),
  sleepPhaseName: S.Optional(S.String()),
  statusPartial: S.Boolean(),
  unavailableStatusSources: S.Array(
    S.Enum(["state", "online", "firmware"] as const),
  ),
});

const analyticsResult = S.Object({
  totalSleepMinutes: S.Number({ jsonType: "integer", minimum: 0 }),
  totalAwakeMinutes: S.Number({ jsonType: "integer", minimum: 0 }),
  totalSootheCount: S.Number({ jsonType: "integer", minimum: 0 }),
  napCount: S.Number({ jsonType: "integer", minimum: 0 }),
  longestNapMinutes: S.Number({ jsonType: "integer", minimum: 0 }),
  lastNapStart: S.Optional(S.String()),
  lastNapEnd: S.Optional(S.String()),
  lastEventTime: S.Optional(S.String()),
  lastEventValue: S.Optional(S.String()),
  events: S.Array(S.Json()),
  partial: S.Boolean(),
  unavailableSources: S.Array(S.Enum(["events", "analytics"] as const)),
});

const controlStateResult = S.Object({
  active: S.Boolean(),
  bounceOn: S.Boolean(),
  bounceLevel: S.Number({ jsonType: "integer", minimum: 0, maximum: 99 }),
  soundOn: S.Boolean(),
  soundLevel: S.Number({ jsonType: "integer", minimum: 0, maximum: 99 }),
  locked: S.Boolean(),
  lockMinutes: S.Number({ jsonType: "integer", minimum: 1, maximum: 60 }),
  shadowVersion: S.Optional(S.Number({ jsonType: "integer", minimum: 0 })),
});

const watchEvent = S.Object({ cradles: S.Array(cradleResult) });

const list = defineCommand({
  name: "list",
  description: "List cribs paired with the Cradlewise account",
  params: S.Object({}),
  result: S.Object({ cradles: S.Array(cradleResult) }),
  secrets,
  scope: ["cli", "mcp", "sdk"],
  handler: async ({ secrets: credentials }) => {
    const client = await createClient(credentials.email, credentials.password);
    const cradles = await client.discoverCradles();
    return { cradles: serializeCradles(cradles.values()) };
  },
});

const status = defineCommand({
  name: "status",
  description:
    "Fetch current state, connectivity, and firmware for one or all cribs",
  params: S.Object({
    cradleId: S.Optional(
      S.String({
        description: "Crib ID; omit to update every paired crib",
        minLength: 1,
        maxLength: 256,
      }),
    ),
  }),
  result: S.Object({ cradles: S.Array(cradleResult) }),
  secrets,
  scope: ["cli", "mcp", "sdk"],
  handler: async ({ params, secrets: credentials }) => {
    const requestedCradleId = optionalCradleId(params.cradleId);
    const client = await createClient(credentials.email, credentials.password);
    const discovered = await client.discoverCradles();
    const selected = selectCradles(discovered, requestedCradleId);
    return { cradles: await updateCradles(client, selected) };
  },
});

const watch = defineStreamCommand({
  name: "watch",
  description:
    "Continuously poll crib state, connectivity, and firmware until cancelled",
  params: S.Object({
    cradleId: S.Optional(
      S.String({
        description: "Crib ID; omit to watch every paired crib",
        minLength: 1,
        maxLength: 256,
      }),
    ),
    intervalSeconds: S.Optional(
      S.Number({
        description: "Polling interval from 15 through 300 seconds",
        default: DEFAULT_WATCH_INTERVAL_SECONDS,
        jsonType: "integer",
        minimum: MIN_WATCH_INTERVAL_SECONDS,
        maximum: MAX_WATCH_INTERVAL_SECONDS,
      }),
    ),
  }),
  event: watchEvent,
  secrets,
  scope: ["cli", "mcp", "sdk"],
  handler: async (context) => {
    const { params, secrets: credentials, signal } = context;
    const requestedCradleId = optionalCradleId(params.cradleId);
    const intervalSeconds = watchInterval(params.intervalSeconds);
    const client = await createClient(credentials.email, credentials.password);
    const discovered = await client.discoverCradles();
    const selected = selectCradles(discovered, requestedCradleId);
    context.status({
      type: "connected",
      message: "Cradlewise status watch started",
    });
    return watchCradles(client, selected, intervalSeconds, signal);
  },
});

const analytics = defineCommand({
  name: "analytics",
  aliases: ["sleep-insights"],
  description: "Fetch aggregated sleep analytics for a crib",
  params: S.Object({
    cradleId: S.String({
      description: "Crib ID",
      minLength: 1,
      maxLength: 256,
    }),
    startHour: S.Optional(
      S.Number({
        description: "Analytics day start hour",
        default: 8,
        jsonType: "integer",
        minimum: 0,
        maximum: 23,
      }),
    ),
    startDate: S.Optional(
      S.String({
        description: "UTC range start (ISO or yyyy-MM-dd HH:mm:ss)",
        minLength: 1,
        maxLength: 64,
      }),
    ),
    endDate: S.Optional(
      S.String({
        description: "UTC range end (ISO or yyyy-MM-dd HH:mm:ss)",
        minLength: 1,
        maxLength: 64,
      }),
    ),
  }),
  result: S.Object({ cradleId: S.String(), analytics: analyticsResult }),
  secrets,
  scope: ["cli", "mcp", "sdk"],
  handler: async ({ params, secrets: credentials }) => {
    const cradleId = requireCradleId(params.cradleId);
    const startHour = optionalStartHour(params.startHour);
    const startDate = optionalApiDate(params.startDate, "startDate");
    const endDate = optionalApiDate(params.endDate, "endDate");
    if (startDate && endDate && startDate > endDate) {
      throw new UserError("startDate must not be after endDate");
    }
    const client = await createClient(credentials.email, credentials.password);
    const cradles = await client.discoverCradles();
    const cradle = selectCradles(cradles, cradleId)[0];
    if (!cradle) throw new UserError(`Crib ${cradleId} was not discovered`);
    const value = await client.fetchSleepAnalytics(cradle, {
      ...(startHour === undefined ? {} : { startHour }),
      ...(startDate === undefined ? {} : { startDate }),
      ...(endDate === undefined ? {} : { endDate }),
    });
    return boundedResult({
      cradleId: cradle.cradleId,
      analytics: value.toJSON(),
    });
  },
});

const controlStatus = defineCommand({
  name: "control-status",
  description: "Read the crib's current bounce, audio, and Smart-lock controls",
  params: S.Object({
    cradleId: S.String({ minLength: 1, maxLength: 256 }),
  }),
  result: S.Object({ cradleId: S.String(), state: controlStateResult }),
  secrets,
  scope: ["cli", "sdk"],
  handler: async ({ params, secrets: credentials }) =>
    withController(
      credentials,
      params.cradleId,
      async (controller, cradle) => ({
        cradleId: cradle.cradleId,
        state: await controller.getState(),
      }),
    ),
});

const startSoothing = defineCommand({
  name: "start",
  description:
    "Start the crib at exact bounce and audio levels, optionally locking Smart mode",
  params: S.Object({
    cradleId: S.String({ minLength: 1, maxLength: 256 }),
    bounceLevel: S.Number({
      description: "Bounce amplitude from 0 through 99",
      jsonType: "integer",
      minimum: 0,
      maximum: 99,
    }),
    soundLevel: S.Number({
      description: "Audio volume from 0 through 99",
      jsonType: "integer",
      minimum: 0,
      maximum: 99,
    }),
    lockMinutes: S.Optional(
      S.Number({
        description:
          "Lock Smart mode for 1 through 60 minutes; omit to stay unlocked",
        jsonType: "integer",
        minimum: 1,
        maximum: 60,
      }),
    ),
  }),
  result: S.Object({ cradleId: S.String(), state: controlStateResult }),
  secrets,
  scope: ["cli", "sdk"],
  handler: async ({ params, secrets: credentials }) =>
    withController(
      credentials,
      params.cradleId,
      async (controller, cradle) => ({
        cradleId: cradle.cradleId,
        state: await controller.startSoothing({
          bounceLevel: params.bounceLevel,
          soundLevel: params.soundLevel,
          ...(params.lockMinutes === undefined
            ? {}
            : { lockMinutes: params.lockMinutes }),
        }),
      }),
    ),
});

const stopSoothing = defineCommand({
  name: "stop",
  description: "Stop both crib bounce and audio",
  params: S.Object({ cradleId: S.String({ minLength: 1, maxLength: 256 }) }),
  result: S.Object({ cradleId: S.String(), state: controlStateResult }),
  secrets,
  scope: ["cli", "sdk"],
  handler: async ({ params, secrets: credentials }) =>
    withController(
      credentials,
      params.cradleId,
      async (controller, cradle) => ({
        cradleId: cradle.cradleId,
        state: await controller.stop(),
      }),
    ),
});

const lockControls = defineCommand({
  name: "lock",
  description: "Lock Smart mode at the current settings",
  params: S.Object({
    cradleId: S.String({ minLength: 1, maxLength: 256 }),
    minutes: S.Number({
      jsonType: "integer",
      minimum: 1,
      maximum: 60,
      default: 30,
    }),
  }),
  result: S.Object({ cradleId: S.String(), state: controlStateResult }),
  secrets,
  scope: ["cli", "sdk"],
  handler: async ({ params, secrets: credentials }) =>
    withController(
      credentials,
      params.cradleId,
      async (controller, cradle) => ({
        cradleId: cradle.cradleId,
        state: await controller.lock(params.minutes),
      }),
    ),
});

const unlockControls = defineCommand({
  name: "unlock",
  description: "Unlock Smart mode",
  params: S.Object({ cradleId: S.String({ minLength: 1, maxLength: 256 }) }),
  result: S.Object({ cradleId: S.String(), state: controlStateResult }),
  secrets,
  scope: ["cli", "sdk"],
  handler: async ({ params, secrets: credentials }) =>
    withController(
      credentials,
      params.cradleId,
      async (controller, cradle) => ({
        cradleId: cradle.cradleId,
        state: await controller.unlock(),
      }),
    ),
});

const refreshConfig = defineCommand({
  name: "refresh-config",
  description:
    "Refresh cached Cognito, API, and AWS IoT settings from the Android app",
  params: S.Object({}),
  result: S.Object({
    config: S.Object({
      cognitoRegion: S.String(),
      apiBaseUrl: S.String(),
      realtimeConfigured: S.Boolean(),
    }),
  }),
  scope: ["cli", "sdk"],
  handler: async () => {
    const config = await refreshAppConfig();
    return boundedResult({
      config: {
        cognitoRegion: config.cognitoRegion,
        apiBaseUrl: config.apiBaseUrl,
        realtimeConfigured: Boolean(config.iotEndpoint),
      },
    });
  },
});

export const cradlewiseToolcraftRoot = defineGroup({
  name: "cradlewise",
  description: "Cradlewise smart crib status, sleep insights, and controls",
  children: [
    list,
    status,
    watch,
    analytics,
    controlStatus,
    startSoothing,
    stopSoothing,
    lockControls,
    unlockControls,
    refreshConfig,
  ],
});

async function createClient(
  email: string,
  password: string,
): Promise<CradlewiseClient> {
  if (
    typeof email !== "string" ||
    utf8ByteLength(email, 320) > 320 ||
    hasControlCharacter(email)
  ) {
    throw new UserError(
      "CRADLEWISE_LOGIN must be a nonempty string no longer than 320 bytes without controls",
    );
  }
  if (email.trim().length === 0) {
    throw new UserError("CRADLEWISE_LOGIN must be a nonempty string");
  }
  if (
    typeof password !== "string" ||
    password.length === 0 ||
    utf8ByteLength(password, 4096) > 4096
  ) {
    throw new UserError(
      "CRADLEWISE_PASSWORD must be a nonempty string no longer than 4096 bytes",
    );
  }
  const appConfig = await getAppConfig();
  const auth = new CradlewiseAuth({ email, password, appConfig });
  return new CradlewiseClient(auth);
}

async function withController<T>(
  credentials: { email: string; password: string },
  requestedCradleId: unknown,
  operation: (controller: CradlewiseController, cradle: Cradle) => Promise<T>,
): Promise<T> {
  const cradleId = requireCradleId(requestedCradleId);
  const client = await createClient(credentials.email, credentials.password);
  const cradles = await client.discoverCradles();
  const cradle = selectCradles(cradles, cradleId)[0];
  if (!cradle) throw new UserError(`Crib ${cradleId} was not discovered`);
  const controller = new CradlewiseController(client.auth, cradle);
  try {
    return boundedResult(await operation(controller, cradle));
  } finally {
    await controller.disconnect();
  }
}

function selectCradles(
  cradles: Map<string, Cradle>,
  cradleId?: string,
): Cradle[] {
  if (cradleId === undefined) return [...cradles.values()];
  const cradle = cradles.get(cradleId);
  if (!cradle)
    throw new UserError(`Crib ${cradleId} is not paired with this account`);
  return [cradle];
}

async function updateCradles(
  client: CradlewiseClient,
  cradles: Cradle[],
): Promise<CradleData[]> {
  const result: CradleData[] = [];
  const budget = createCradleListBudget();
  for (let offset = 0; offset < cradles.length; offset += 8) {
    const batch = cradles.slice(offset, offset + 8);
    await Promise.all(batch.map((cradle) => client.updateCradle(cradle)));
    for (const cradle of batch) {
      const snapshot = cradle.toJSON();
      addResultToBudget(snapshot, budget);
      result.push(snapshot);
    }
  }
  return result;
}

function serializeCradles(cradles: Iterable<Cradle>): CradleData[] {
  const result: CradleData[] = [];
  const budget = createCradleListBudget();
  for (const cradle of cradles) {
    const snapshot = cradle.toJSON();
    addResultToBudget(snapshot, budget);
    result.push(snapshot);
  }
  return result;
}

function optionalCradleId(value: unknown): string | undefined {
  return value === undefined ? undefined : requireCradleId(value);
}

function requireCradleId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    utf8ByteLength(value, 256) > 256 ||
    value !== value.trim() ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    value.includes("%") ||
    value.includes("?") ||
    value.includes("#") ||
    hasControlCharacter(value)
  ) {
    throw new UserError("cradleId must be a nonempty identifier");
  }
  return value;
}

function optionalApiDate(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new UserError(`${field} must be a valid date`);
  }
  try {
    return formatApiDate(value);
  } catch {
    throw new UserError(`${field} must be a valid date`);
  }
}

function optionalStartHour(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > 23
  ) {
    throw new UserError("startHour must be an integer from 0 through 23");
  }
  return value;
}

function watchInterval(value: unknown): number {
  if (value === undefined) return DEFAULT_WATCH_INTERVAL_SECONDS;
  if (
    !Number.isInteger(value) ||
    (value as number) < MIN_WATCH_INTERVAL_SECONDS ||
    (value as number) > MAX_WATCH_INTERVAL_SECONDS
  ) {
    throw new UserError(
      "intervalSeconds must be an integer from 15 through 300",
    );
  }
  return value as number;
}

async function* watchCradles(
  client: CradlewiseClient,
  cradles: Cradle[],
  intervalSeconds: number,
  signal: AbortSignal,
): AsyncGenerator<Static<typeof watchEvent>> {
  while (!signal.aborted) {
    yield boundedResult({
      cradles: await updateCradles(client, cradles),
    }) as Static<typeof watchEvent>;
    await waitForWatchInterval(intervalSeconds * 1000, signal);
  }
}

function waitForWatchInterval(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    const timer = setTimeout(finish, milliseconds);
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolvePromise();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 31 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

function boundedResult<T>(value: T): T {
  const budget: ResultBudget = { nodes: 0, textBytes: 0 };
  addResultToBudget(value, budget);
  return value;
}

interface ResultBudget {
  nodes: number;
  textBytes: number;
}

function createCradleListBudget(): ResultBudget {
  return {
    nodes: 2,
    textBytes: 7,
  };
}

function addResultToBudget(value: unknown, budget: ResultBudget): void {
  const pending: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (pending.length > 0) {
    const current = pending.pop();
    budget.nodes += 1;
    if (budget.nodes > MAX_TOOL_RESULT_NODES) {
      throw new UserError("Command result exceeds the safe size limit");
    }
    if (typeof current === "string") {
      budget.textBytes += utf8ByteLength(
        current,
        MAX_TOOL_RESULT_TEXT_BYTES - budget.textBytes,
      );
    } else if (Array.isArray(current)) {
      if (seen.has(current)) {
        throw new UserError("Command result is not JSON-safe");
      }
      seen.add(current);
      for (let index = 0; index < current.length; index += 1) {
        if (!Object.hasOwn(current, index)) {
          throw new UserError("Command result is not JSON-safe");
        }
        pending.push(current[index]);
      }
    } else if (current !== null && typeof current === "object") {
      if (seen.has(current)) {
        throw new UserError("Command result is not JSON-safe");
      }
      seen.add(current);
      for (const key in current) {
        if (!Object.hasOwn(current, key)) continue;
        budget.textBytes += utf8ByteLength(
          key,
          MAX_TOOL_RESULT_TEXT_BYTES - budget.textBytes,
        );
        const entry: unknown = (current as Record<string, unknown>)[key];
        pending.push(entry);
      }
    } else if (typeof current === "number" && !Number.isFinite(current)) {
      throw new UserError("Command result is not JSON-safe");
    } else if (
      current !== null &&
      typeof current !== "boolean" &&
      typeof current !== "number"
    ) {
      throw new UserError("Command result is not JSON-safe");
    }
    if (budget.textBytes > MAX_TOOL_RESULT_TEXT_BYTES) {
      throw new UserError("Command result exceeds the safe size limit");
    }
  }
}
