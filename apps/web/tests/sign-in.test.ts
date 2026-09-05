import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  OAUTH_PROVIDERS,
  emailSwitchedOff,
  otherProvider,
  probeAuthorize,
  providerName,
  providerSwitchedOff,
  startOAuth,
} from "@/lib/sign-in";

/**
 * The sign in card's decisions.
 *
 * The rule these tests hold is that a refusal is only ever read from a
 * definite answer. A provider the service has switched off is named as such
 * in the product's own sentence; anything less certain sends the browser on
 * exactly as it always has, so the probe can fall back but never invent.
 */

const OFF = {
  status: 400,
  body: {
    code: 400,
    error_code: "validation_failed",
    msg: "Unsupported provider: provider is not enabled",
  },
};

describe("providerSwitchedOff", () => {
  it("reads the service's own refusal", () => {
    expect(providerSwitchedOff(OFF)).toBe(true);
    expect(providerSwitchedOff({ status: 400, body: { msg: "Unsupported provider" } })).toBe(true);
  });

  it("reads nothing else as a switched off provider", () => {
    expect(providerSwitchedOff(null)).toBe(false);
    expect(providerSwitchedOff({ status: 302, body: null })).toBe(false);
    expect(providerSwitchedOff({ status: 400, body: { msg: "Bad redirect" } })).toBe(false);
    expect(providerSwitchedOff({ status: 500, body: OFF.body })).toBe(false);
    expect(providerSwitchedOff({ status: 400, body: "not enabled" })).toBe(false);
  });
});

describe("emailSwitchedOff", () => {
  it("reads the words the service uses for a disabled email sign in", () => {
    expect(emailSwitchedOff("Email logins are disabled")).toBe(true);
    expect(emailSwitchedOff("Signups not allowed for otp")).toBe(true);
    expect(emailSwitchedOff("Email rate limit exceeded")).toBe(false);
    expect(emailSwitchedOff(null)).toBe(false);
    expect(emailSwitchedOff(undefined)).toBe(false);
  });
});

describe("startOAuth", () => {
  it("sends the browser on when the provider answers with a redirect", async () => {
    const navigate = vi.fn();
    const outcome = await startOAuth("github", {
      authorizeUrl: async () => "https://auth.example/authorize?provider=github",
      probe: async () => ({ status: 302, body: null }),
      navigate,
    });
    expect(outcome).toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith("https://auth.example/authorize?provider=github");
  });

  it("names a switched off provider and never leaves the page for it", async () => {
    const navigate = vi.fn();
    const outcome = await startOAuth("google", {
      authorizeUrl: async () => "https://auth.example/authorize?provider=google",
      probe: async () => OFF,
      navigate,
    });
    expect(outcome).toEqual({ ok: false, reason: "providerOff" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("treats any other definite refusal as a plain failure", async () => {
    const navigate = vi.fn();
    const outcome = await startOAuth("google", {
      authorizeUrl: async () => "https://auth.example/authorize?provider=google",
      probe: async () => ({ status: 503, body: null }),
      navigate,
    });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(navigate).not.toHaveBeenCalled();
  });

  it("lets the browser go when the probe could not be made at all", async () => {
    const navigate = vi.fn();
    const outcome = await startOAuth("github", {
      authorizeUrl: async () => "https://auth.example/authorize?provider=github",
      probe: async () => null,
      navigate,
    });
    expect(outcome).toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("lets the browser go when the probe throws", async () => {
    const navigate = vi.fn();
    const outcome = await startOAuth("github", {
      authorizeUrl: async () => "https://auth.example/authorize?provider=github",
      probe: async () => {
        throw new TypeError("Failed to fetch");
      },
      navigate,
    });
    expect(outcome).toEqual({ ok: true });
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("fails plainly when no address could be built", async () => {
    const navigate = vi.fn();
    const probe = vi.fn();
    const outcome = await startOAuth("github", {
      authorizeUrl: async () => null,
      probe,
      navigate,
    });
    expect(outcome).toEqual({ ok: false, reason: "failed" });
    expect(probe).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("probeAuthorize", () => {
  it("reads an opaque redirect as the go ahead it is, without following it", async () => {
    const fetchImpl = vi.fn(async () => ({ type: "opaqueredirect", status: 0 }) as Response);
    const answer = await probeAuthorize("https://auth.example/authorize", fetchImpl);
    expect(answer).toEqual({ status: 302, body: null });
    expect(fetchImpl).toHaveBeenCalledWith("https://auth.example/authorize", {
      redirect: "manual",
      credentials: "omit",
    });
  });

  it("hands back the status and the parsed body of a refusal", async () => {
    const fetchImpl = vi.fn(
      async () =>
        ({
          type: "cors",
          status: 400,
          json: async () => OFF.body,
        }) as unknown as Response,
    );
    const answer = await probeAuthorize("https://auth.example/authorize", fetchImpl);
    expect(answer).toEqual({ status: 400, body: OFF.body });
  });

  it("answers null when the request itself cannot be made", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await probeAuthorize("https://auth.example/authorize", fetchImpl)).toBeNull();
  });
});

describe("the two providers", () => {
  it("are offered GitHub first and named the way they spell themselves", () => {
    expect([...OAUTH_PROVIDERS]).toEqual(["github", "google"]);
    expect(providerName("github")).toBe("GitHub");
    expect(providerName("google")).toBe("Google");
    expect(otherProvider("github")).toBe("google");
    expect(otherProvider("google")).toBe("github");
  });
});

/* The jsdom environment supplies its own URL class, which node's file system
   does not accept, so a repository file is read through a plain path. */
function source(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url).href), "utf8");
}

describe("the marks", () => {
  it("draw the GitHub mark from the one path the file carries", () => {
    const file = source("../public/marks/github-mark.svg");
    const ui = source("../components/ui.tsx");
    const path = file.match(/ d="([^"]+)"/u)?.[1];
    expect(path).toBeDefined();
    expect(file).toContain('fill="currentColor"');
    expect(ui).toContain(`d="${path}"`);
  });

  it("serve the Google G as the official file, unmodified", () => {
    const file = source("../public/marks/google-g.svg");
    for (const colour of ["#4285F4", "#34A853", "#FBBC05", "#EA4335"]) {
      expect(file).toContain(colour);
    }
  });

  it("never say Gmail", () => {
    expect(source("../messages/en.json")).not.toContain("Gmail");
    expect(source("../components/sign-in-card.tsx")).not.toContain("Gmail");
  });
});
