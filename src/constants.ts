export const SLEEP_PHASE_NAMES = {
  0: "away",
  1: "awake",
  2: "stirring",
  3: "stirring",
  4: "sleep",
  5: "awake",
  6: "stirring",
} as const satisfies Record<number, string>;

export const DEFAULT_REGION = "us-east-1";
