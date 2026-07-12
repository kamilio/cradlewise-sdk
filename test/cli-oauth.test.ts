import { describe, expect, it, vi } from "vitest";
import { prepareOAuthCLI, promptLine } from "../src/cli-oauth.js";

describe("CLI OAuth credential prompt", () => {
  it("prompts for an email and masked password and exposes them as command secrets", async () => {
    const prompt = vi
      .fn<(label: string, secret?: boolean) => Promise<string>>()
      .mockResolvedValueOnce(" parent@example.com ")
      .mockResolvedValueOnce("correct horse battery staple");

    const prepared = await prepareOAuthCLI({
      argv: ["status", "--oauth", "--output", "json"],
      env: { EXISTING: "value" },
      prompt,
    });

    expect(prepared).toEqual({
      argv: ["status", "--output", "json"],
      env: {
        EXISTING: "value",
        CRADLEWISE_LOGIN: "parent@example.com",
        CRADLEWISE_PASSWORD: "correct horse battery staple",
      },
      oauth: true,
    });
    expect(prompt).toHaveBeenNthCalledWith(1, "Cradlewise account email: ");
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      "Cradlewise account password: ",
      true,
    );
  });

  it("leaves environment authentication unchanged without --oauth", async () => {
    const prompt = vi.fn();
    const prepared = await prepareOAuthCLI({
      argv: ["list"],
      env: {
        CRADLEWISE_LOGIN: "configured@example.com",
        CRADLEWISE_PASSWORD: "configured-password",
      },
      prompt,
    });
    expect(prepared.oauth).toBe(false);
    expect(prepared.argv).toEqual(["list"]);
    expect(prepared.env.CRADLEWISE_LOGIN).toBe("configured@example.com");
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not prompt for informational commands", async () => {
    const prompt = vi.fn();
    const prepared = await prepareOAuthCLI({
      argv: ["status", "--oauth", "--help"],
      env: {},
      prompt,
    });
    expect(prepared).toEqual({
      argv: ["status", "--help"],
      env: {},
      oauth: true,
    });
    expect(prompt).not.toHaveBeenCalled();
  });

  it("rejects duplicate flags and empty prompted credentials", async () => {
    await expect(
      prepareOAuthCLI({ argv: ["list", "--oauth", "--oauth"], env: {} }),
    ).rejects.toThrow("only be specified once");
    await expect(
      prepareOAuthCLI({
        argv: ["list", "--oauth"],
        env: {},
        prompt: () => Promise.resolve(" "),
      }),
    ).rejects.toThrow("email is required");
    await expect(
      prepareOAuthCLI({
        argv: ["list", "--oauth"],
        env: {},
        prompt: vi
          .fn<(label: string, secret?: boolean) => Promise<string>>()
          .mockResolvedValueOnce("parent@example.com")
          .mockResolvedValueOnce(""),
      }),
    ).rejects.toThrow("password is required");
  });

  it("requires a TTY before reading a credential", async () => {
    await expect(
      promptLine("Password: ", true, {
        input: { isTTY: false } as unknown as NodeJS.ReadableStream & {
          isTTY: boolean;
        },
        output: { isTTY: true } as unknown as NodeJS.WritableStream & {
          isTTY: boolean;
        },
      }),
    ).rejects.toThrow("interactive terminal");
  });
});
