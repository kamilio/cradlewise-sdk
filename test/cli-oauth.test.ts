import { describe, expect, it, vi } from "vitest";
import {
  prepareOAuthCLI,
  startBrowserCredentialLogin,
} from "../src/cli-oauth.js";

describe("CLI OAuth browser login", () => {
  it("uses browser-submitted credentials as command secrets", async () => {
    const browserLogin = vi.fn().mockResolvedValue({
      email: "parent@example.com",
      password: "correct horse battery staple",
    });
    const prepared = await prepareOAuthCLI({
      argv: ["status", "--oauth", "--output", "json"],
      env: { EXISTING: "value" },
      browserLogin,
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
    expect(browserLogin).toHaveBeenCalledOnce();
  });

  it("serves a one-time login URL and receives its form", async () => {
    let loginUrl: URL | undefined;
    const login = startBrowserCredentialLogin({
      bindHost: "127.0.0.1",
      publicHost: "127.0.0.1",
      timeoutMs: 5_000,
      token: "test_token_1234567890",
      onUrl: (url) => {
        loginUrl = url;
      },
    });
    await vi.waitFor(() => expect(loginUrl).toBeInstanceOf(URL));
    const url = loginUrl as unknown as URL;
    const page = await fetch(url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Sign in to Cradlewise");
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        email: " parent@example.com ",
        password: "browser-password",
      }),
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Login received");
    await expect(login).resolves.toEqual({
      email: "parent@example.com",
      password: "browser-password",
    });
  });

  it("rejects unknown paths, invalid forms, and expired login attempts", async () => {
    let loginUrl: URL | undefined;
    const login = startBrowserCredentialLogin({
      bindHost: "127.0.0.1",
      publicHost: "127.0.0.1",
      timeoutMs: 150,
      token: "test_token_1234567890",
      onUrl: (url) => {
        loginUrl = url;
      },
    });
    await vi.waitFor(() => expect(loginUrl).toBeInstanceOf(URL));
    const url = loginUrl as unknown as URL;
    expect(await fetch(new URL("/wrong", url))).toMatchObject({ status: 404 });
    expect(
      await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "email=parent%40example.com",
      }),
    ).toMatchObject({ status: 400 });
    await expect(login).rejects.toThrow("timed out");
  });

  it("leaves environment authentication unchanged without --oauth", async () => {
    const browserLogin = vi.fn();
    const prepared = await prepareOAuthCLI({
      argv: ["list"],
      env: {
        CRADLEWISE_LOGIN: "configured@example.com",
        CRADLEWISE_PASSWORD: "configured-password",
      },
      browserLogin,
    });
    expect(prepared.oauth).toBe(false);
    expect(prepared.argv).toEqual(["list"]);
    expect(prepared.env.CRADLEWISE_LOGIN).toBe("configured@example.com");
    expect(browserLogin).not.toHaveBeenCalled();
  });

  it("does not start browser login for informational commands", async () => {
    const browserLogin = vi.fn();
    const prepared = await prepareOAuthCLI({
      argv: ["status", "--oauth", "--help"],
      env: {},
      browserLogin,
    });
    expect(prepared).toEqual({
      argv: ["status", "--help"],
      env: {},
      oauth: true,
    });
    expect(browserLogin).not.toHaveBeenCalled();
  });

  it("rejects duplicate flags", async () => {
    await expect(
      prepareOAuthCLI({ argv: ["list", "--oauth", "--oauth"], env: {} }),
    ).rejects.toThrow("only be specified once");
  });
});
