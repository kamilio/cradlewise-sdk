import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";
import { toJsonSchema } from "toolcraft";
import { cradlewiseToolcraftRoot } from "../src/toolcraft.js";

function validator(name: string) {
  const command = cradlewiseToolcraftRoot.children.find(
    (entry) => entry.name === name,
  );
  if (!command || command.kind !== "command" || !command.result)
    throw new Error(`Missing command result: ${name}`);
  return new Ajv().compile(toJsonSchema(command.result));
}

describe("control result schemas", () => {
  const results: Array<[string, object]> = [
    [
      "start",
      {
        active: true,
        bounceOn: true,
        bounceLevel: 30,
        soundOn: false,
        soundLevel: 0,
        locked: false,
      },
    ],
    ["stop", { active: false, bounceOn: false, soundOn: false }],
    ["lock", { locked: true, lockMinutes: 15 }],
    ["unlock", { locked: false }],
  ];
  for (const [name, state] of results) {
    it(`${name} accepts acknowledged fields without requiring unrelated state`, () => {
      expect(validator(name)({ cradleId: "crib", state })).toBe(true);
    });
    it(`${name} accepts supported reported intensity and limit fields`, () => {
      expect(
        validator(name)({
          cradleId: "crib",
          state: {
            ...state,
            bounceIntensityLevel: 3,
            soundIntensityLevel: 2,
            maxBouncePercent: 70,
            maxSoundPercent: 80,
            shadowVersion: 5,
          },
        }),
      ).toBe(true);
    });
    it(`${name} still checks supplied field types`, () => {
      expect(
        validator(name)({
          cradleId: "crib",
          state: { ...state, active: "unknown" },
        }),
      ).toBe(false);
    });
    it(`${name} still requires result identity`, () => {
      expect(validator(name)({ state })).toBe(false);
    });
  }
  it("keeps full state required for control-status", () => {
    expect(
      validator("control-status")({
        cradleId: "crib",
        state: { locked: true },
      }),
    ).toBe(false);
    expect(
      validator("control-status")({
        cradleId: "crib",
        state: {
          active: false,
          bounceOn: false,
          bounceLevel: 0,
          soundOn: false,
          soundLevel: 0,
          locked: false,
          lockMinutes: 30,
        },
      }),
    ).toBe(true);
  });
  it("accepts valid optional telemetry on a full state read", () => {
    expect(
      validator("control-status")({
        cradleId: "crib",
        state: {
          active: true,
          bounceOn: true,
          bounceLevel: 30,
          soundOn: true,
          soundLevel: 40,
          locked: false,
          lockMinutes: 30,
          bounceIntensityLevel: 3,
          soundIntensityLevel: 2,
          maxBouncePercent: 70,
          maxSoundPercent: 80,
        },
      }),
    ).toBe(true);
  });
});
