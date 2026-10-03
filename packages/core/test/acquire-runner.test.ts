import { acquisitionAccountId } from "../src/acquire/identity.js";
import { describe, expect, it } from "vitest";
import {
  ACQUISITION_DISCLOSURE,
  CODE_ASSIST_PROJECT_FIELD,
  CREDENTIAL_FAILURE_SENTENCE,
  claudeSpec,
  codexSpec,
  collectionReasonFor,
  geminiCliSpec,
  grokSpec,
  kimiSpec,
  openrouterSpec,
  runAcquisition,
  type AcquisitionProvider,
  type AcquisitionReply,
  type AcquisitionRequest,
  type CredentialResult,
  type RawMeter
} from "../src/index.js";

const NOW = "2026-01-01T00:00:00.000Z";
const SYNTHETIC_TOKEN = "synthetic-access-token-0000";
function credential(
  accountId: string | null = null,
  origin: "vendor_file" | "vendor_store" | "user_key" =
    "vendor_file"
): CredentialResult {
  return {
    ok: true,
    credential: {
      secret: SYNTHETIC_TOKEN,
      accountId,
      ...(accountId === null ? {} : {
        codexHome: "/synthetic/codex-home",
        executable: "/synthetic/codex"
      }),
      expiresAtMilliseconds: null,
      origin
    }
  };
}

/** One believable reading, in the shape a connector parser produces. */
function meter(provider: RawMeter["provider"]): RawMeter {
  return {
    provider,
    meter: "FIVE_HOUR",
    value: 41,
    unit: "PERCENT",
    window: { kind: "rolling", durationSeconds: 18_000 },
    resetAt: "2026-01-01T05:00:00.000Z",
    source: "internal_payload",
    precision: "estimated",
    observedAt: NOW,
    expiresAt: "2026-01-01T00:01:00.000Z",
    labels: {
      credentialOrigin: "official-local-tool",
      dataInterfaceStatus: "internal-endpoint",
      automationRisk: "high",
      verification: "UNVERIFIED"
    }
  };
}

function reply(
  status: number,
  body: unknown,
  retryAfterSeconds: number | null = null
): AcquisitionReply {
  return { status, body: JSON.stringify(body), retryAfterSeconds };
}

describe("one acquisition round", () => {
  it("reads a provider, stamps it and reports it once", async () => {
    const sent: AcquisitionRequest[] = [];
    const result = await runAcquisition([codexSpec(() => [meter("CODEX")])], {
      transport: async (request) => {
        sent.push(request);
        return reply(200, { rateLimits: {} });
      },
      now: NOW,
      schedule: {},
      readCredential: async () => credential("acct-1"),
      stamp: (meters) => meters.map((entry) => ({ ...entry, writer: "cli" }))
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: "codex_app_server",
      endpoint: "codex_usage",
      codexHome: "/synthetic/codex-home",
      executable: "/synthetic/codex",
      expectedAccountId: acquisitionAccountId("CODEX", { secret: "fixture", accountId: "acct-1" })
    });
    expect(result.rows).toEqual([{
      provider: "CODEX",
      accountId: acquisitionAccountId("CODEX", { secret: "fixture", accountId: "acct-1" }),
      detected: true,
      status: "read",
      reason: null,
      nextAttemptAt: "2026-01-01T00:15:00.000Z",
      disclosure: ACQUISITION_DISCLOSURE.codex
    }]);
    expect(result.reports).toHaveLength(1);
    const report = result.reports[0];
    expect(report?.ok).toBe(true);
    expect(report?.ok === true ? report.snapshots[0]?.writer : null).toBe("cli");
    expect(result.schedule["CODEX"]?.outcome).toBe("ok");
  });

  it("asks nothing while a provider is inside its own backoff", async () => {
    let asked = 0;
    const result = await runAcquisition([kimiSpec(() => [meter("KIMI")])], {
      transport: async () => {
        asked += 1;
        return reply(200, {});
      },
      now: NOW,
      schedule: {
        KIMI: {
          lastAttemptAt: "2025-12-31T23:30:00.000Z",
          nextAttemptAt: "2026-01-01T00:30:00.000Z",
          outcome: "rate_limited"
        }
      },
      readCredential: async () => credential()
    });
    expect(asked).toBe(0);
    expect(result.rows[0]?.status).toBe("waiting");
    expect(result.rows[0]?.nextAttemptAt).toBe("2026-01-01T00:30:00.000Z");
    expect(result.reports).toEqual([]);
  });

  it("backs off per the agreed exponential plan on a rate limit and a day on a refusal", async () => {
    const rateLimited = await runAcquisition([grokSpec(() => [meter("GROK")])], {
      transport: async () => reply(429, {}),
      now: NOW,
      schedule: {},
      readCredential: async () => credential("user-1")
    });
    expect(rateLimited.rows[0]?.status).toBe("stale");
    expect(rateLimited.rows[0]?.nextAttemptAt).toBe("2026-01-01T00:01:00.000Z");
    expect(rateLimited.reports).toEqual([]);

    const blocked = await runAcquisition([grokSpec(() => [meter("GROK")])], {
      transport: async () => reply(403, {}),
      now: NOW,
      schedule: {},
      readCredential: async () => credential("user-1")
    });
    expect(blocked.rows[0]?.nextAttemptAt).toBe("2026-01-02T00:00:00.000Z");
    expect(blocked.schedule["GROK"]?.outcome).toBe("blocked");
  });

  it.each(["signed-out", "signed-out-codex"])(
    "maps the %s Codex sign out to availability, daily backoff and a revision sensitive refusal",
    async (scenario) => {
    const first = await runAcquisition([codexSpec(() => [meter("CODEX")])], {
      transport: async (request) => {
        if (request.kind !== "codex_app_server") throw new Error("expected Codex app server request");
        expect(request).toMatchObject({ kind: "codex_app_server", endpoint: "codex_usage" });
        expect(JSON.stringify(request)).not.toContain("Bearer ");
        return { status: 401, body: "", retryAfterSeconds: null };
      },
      now: NOW,
      schedule: {},
      readCredential: async () => credential("acct-1")
    });
    expect(first.rows[0]).toMatchObject({
      availability: "expired_credentials",
      nextAttemptAt: "2026-01-02T00:00:00.000Z"
    });
    expect(first.schedule["CODEX"]?.outcome).toBe("unauthorized");
    expect(first.schedule["CODEX"]?.refusalRevision).toMatch(/^[a-f0-9]{64}$/u);

    let reads = 0;
    const second = await runAcquisition([codexSpec(() => [meter("CODEX")])], {
      transport: async () => {
        reads += 1;
        return reply(200, { rateLimits: {} });
      },
      now: "2026-01-01T00:01:00.000Z",
      schedule: first.schedule,
      readCredential: async () => ({
        ...credential("acct-1"),
        credential: { ...(credential("acct-1") as Extract<CredentialResult, { ok: true }>).credential, secret: "rotated-synthetic-token" }
      })
    });
    expect(reads).toBe(1);
    expect(second.rows[0]?.status).toBe("read");
    }
  );

  it("treats a vanished Codex executable as a missing local credential", async () => {
    const result = await runAcquisition([codexSpec(() => [meter("CODEX")])], {
      transport: async () => ({ status: 0, body: "", retryAfterSeconds: null, missingCredential: true }),
      now: NOW,
      schedule: {},
      readCredential: async () => credential("acct-1")
    });
    expect(result.rows[0]).toMatchObject({ detected: false, status: "not_detected", nextAttemptAt: null });
    expect(result.schedule["CODEX"]).toBeUndefined();
  });

  it("obeys a Retry-After longer than its own backoff", async () => {
    const result = await runAcquisition([kimiSpec(() => [meter("KIMI")])], {
      transport: async () => reply(429, {}, 7_200),
      now: NOW,
      schedule: {},
      readCredential: async () => credential()
    });
    expect(result.rows[0]?.nextAttemptAt).toBe("2026-01-01T02:00:00.000Z");
  });

  it("never writes when a read failed", async () => {
    for (const status of [401, 429, 500]) {
      const result = await runAcquisition([kimiSpec(() => [meter("KIMI")])], {
        transport: async () => reply(status, {}),
        now: NOW,
        schedule: {},
        readCredential: async () => credential()
      });
      expect(result.reports).toEqual([]);
      expect(result.rows[0]?.status).toBe("stale");
    }
  });

  it("calls a shape it cannot read drift, and still writes nothing", async () => {
    const result = await runAcquisition([kimiSpec(() => null)], {
      transport: async () => reply(200, { something: "else" }),
      now: NOW,
      schedule: {},
      readCredential: async () => credential()
    });
    expect(result.schedule["KIMI"]?.outcome).toBe("drift");
    expect(result.reports).toEqual([]);
    expect(result.rows[0]?.reason).toContain("shape");
  });

  it("reports a transport failure without ever formatting it", async () => {
    const result = await runAcquisition([kimiSpec(() => [meter("KIMI")])], {
      transport: async () => {
        throw new Error("connect ECONNREFUSED 10.0.0.1:443 token=" + SYNTHETIC_TOKEN);
      },
      now: NOW,
      schedule: {},
      readCredential: async () => credential()
    });
    expect(result.schedule["KIMI"]?.outcome).toBe("transport");
    expect(JSON.stringify(result)).not.toContain(SYNTHETIC_TOKEN);
    expect(JSON.stringify(result)).not.toContain("ECONNREFUSED");
  });

  it("says a provider is not set up here rather than failing it", async () => {
    const result = await runAcquisition([codexSpec(() => [meter("CODEX")])], {
      transport: async () => reply(200, {}),
      now: NOW,
      schedule: {},
      readCredential: async () => ({ ok: false, reason: "absent" })
    });
    expect(result.rows[0]).toMatchObject({
      detected: false,
      status: "not_detected",
      nextAttemptAt: null
    });
    /* A local absence earns no network backoff: nothing was asked, and the fix
       is on this machine. */
    expect(result.schedule["CODEX"]).toBeUndefined();
  });

  it("keeps the Claude poll off until somebody turns it on", async () => {
    let asked = 0;
    const off = await runAcquisition(
      [claudeSpec({ parse: () => [meter("CLAUDE")], enabled: false })],
      {
        transport: async () => {
          asked += 1;
          return reply(200, {});
        },
        now: NOW,
        schedule: {},
        readCredential: async () => credential()
      }
    );
    expect(asked).toBe(0);
    expect(off.rows[0]?.status).toBe("off");
    expect(off.rows[0]?.reason).toContain("off");
    expect(off.rows[0]?.disclosure).toBe(ACQUISITION_DISCLOSURE.claude);

    const sent: AcquisitionRequest[] = [];
    const on = await runAcquisition(
      [claudeSpec({ parse: () => [meter("CLAUDE")], enabled: true })],
      {
        transport: async (request) => {
          sent.push(request);
          return reply(200, {});
        },
        now: NOW,
        schedule: {},
        readCredential: async () => credential()
      }
    );
    expect(on.rows[0]?.status).toBe("read");
    expect(sent[0] !== undefined && sent[0].kind === undefined ? sent[0].url : undefined).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(sent[0] !== undefined && sent[0].kind === undefined ? sent[0].headers["anthropic-beta"] : undefined).toBe("oauth-2025-04-20");
  });

  it("scopes the Code Assist quota read to the project the bootstrap named", async () => {
    const sent: AcquisitionRequest[] = [];
    const result = await runAcquisition([geminiCliSpec(() => [meter("GEMINI_CLI")])], {
      transport: async (request) => {
        sent.push(request);
        return request.endpoint === "code_assist_load"
          ? reply(200, { [CODE_ASSIST_PROJECT_FIELD]: "managed-project-123" })
          : reply(200, { buckets: [] });
      },
      now: NOW,
      schedule: {},
      readCredential: async () => credential()
    });
    expect(sent.map((request) => request.endpoint)).toEqual([
      "code_assist_load",
      "code_assist_quota"
    ]);
    expect(sent[1] !== undefined && sent[1].kind === undefined ? sent[1].body : null).toContain("managed-project-123");
    expect(result.rows[0]?.status).toBe("read");
  });

  it.each([
    ["paid consumer wins over standard current tier", { currentTier: { id: "standard-tier" }, paidTier: { id: "g1-pro-tier" } }, false],
    ["null current tier still reads paid tier", { currentTier: null, paidTier: { id: "free-tier" } }, false],
    ["standard is collected", { currentTier: { id: "standard-tier" } }, true],
    ["enterprise is collected", { currentTier: { id: "enterprise-tier" } }, true],
    ["unknown is left to normal collection", { currentTier: { id: "unknown-tier" } }, true],
  ] as const)("applies the verified Gemini tier decision before quota request, %s", async (_name, tier, collects) => {
    const sent: AcquisitionRequest[] = [];
    const result = await runAcquisition([geminiCliSpec(() => [meter("GEMINI_CLI")])], {
      transport: async (request) => {
        sent.push(request);
        return request.endpoint === "code_assist_load"
          ? reply(200, { cloudaicompanionProject: "managed-project-123", ...tier })
          : reply(200, { buckets: [] });
      },
      now: NOW,
      schedule: {},
      readCredential: async () => credential()
    });
    expect(sent.map((request) => request.endpoint)).toEqual(
      collects ? ["code_assist_load", "code_assist_quota"] : ["code_assist_load"]
    );
    if (collects) {
      expect(result.rows[0]?.status).toBe("read");
    } else {
      expect(result.schedule["GEMINI_CLI"]?.outcome).toBe("quota_unavailable");
      expect(result.rows[0]).toMatchObject({
        availability: "quota_unavailable",
        reason: "Google ended Gemini CLI sign in for this plan on June 18, 2026."
      });
    }
  });

  it("releases a retired plan's day of backoff as soon as the credential changes", async () => {
    // Astra, 2026-10-01: a retired consumer login at 00:00, supported credentials at 00:01.
    const retired = await runAcquisition([geminiCliSpec(() => [meter("GEMINI_CLI")])], {
      transport: async () => reply(200, { cloudaicompanionProject: "managed-project-123", currentTier: { id: "free-tier" } }),
      now: NOW,
      schedule: {},
      readCredential: async () => credential("user-1")
    });
    expect(retired.schedule["GEMINI_CLI"]?.outcome).toBe("quota_unavailable");
    const sent: AcquisitionRequest[] = [];
    const replaced = await runAcquisition([geminiCliSpec(() => [meter("GEMINI_CLI")])], {
      transport: async (request) => {
        sent.push(request);
        return request.endpoint === "code_assist_load"
          ? reply(200, { cloudaicompanionProject: "managed-project-123", currentTier: { id: "standard-tier" } })
          : reply(200, { buckets: [] });
      },
      now: "2026-01-01T00:01:00.000Z",
      schedule: retired.schedule,
      readCredential: async () => credential("user-2")
    });
    expect(sent.map((request) => request.endpoint)).toEqual(["code_assist_load", "code_assist_quota"]);
    expect(replaced.rows[0]?.status).toBe("read");
  });

  it("lets one provider that throws anywhere cost only itself", async () => {
    /*
     * The request stage, not the parser. A transport that throws for one
     * provider used to be caught, but a credential reader or a spec callback
     * that threw took the whole round with it.
     */
    const exploding = kimiSpec(() => [meter("KIMI")]);
    const healthy = codexSpec(() => [meter("CODEX")]);
    const result = await runAcquisition([exploding, healthy], {
      transport: async () => reply(200, {}),
      now: NOW,
      schedule: {},
      readCredential: async (provider) => {
        if (provider === "KIMI") throw new Error("a credential reader gave up");
        return credential("acct-1");
      }
    });
    expect(result.rows).toHaveLength(2);
    expect(result.schedule["KIMI"]?.outcome).toBe("drift");
    expect(result.rows[1]?.status).toBe("read");
    expect(result.reports).toHaveLength(1);
  });

  it("lets a spec callback that throws cost only its own provider", async () => {
    const cursed = {
      ...codexSpec(() => [meter("CODEX")]),
      accountIdFor: () => {
        throw new Error("a callback nobody expected to fail");
      }
    };
    const healthy = kimiSpec(() => [meter("KIMI")]);
    const result = await runAcquisition([cursed, healthy], {
      transport: async () => reply(200, {}),
      now: NOW,
      schedule: {},
      readCredential: async () => credential("acct-1")
    });
    expect(result.schedule["CODEX"]?.outcome).toBe("drift");
    expect(result.rows[1]?.status).toBe("read");
  });

  it("lets one parser that throws cost only its own provider", async () => {
    const thrower = kimiSpec(() => {
      throw new Error("a shape nobody anticipated");
    });
    const healthy = codexSpec(() => [meter("CODEX")]);
    const result = await runAcquisition([thrower, healthy], {
      transport: async () => reply(200, {}),
      now: NOW,
      schedule: {},
      readCredential: async () => credential("acct-1")
    });
    expect(result.rows).toHaveLength(2);
    expect(result.schedule["KIMI"]?.outcome).toBe("drift");
    /* The whole point: the six healthy providers behind the thrower still get
       read. Before this, one exception ended the round. */
    expect(result.rows[1]?.status).toBe("read");
    expect(result.reports).toHaveLength(1);
  });

  it("reads OpenRouter with the key this product stores itself", async () => {
    const asked: AcquisitionProvider[] = [];
    const sent: AcquisitionRequest[] = [];
    await runAcquisition([openrouterSpec(() => [meter("OPENROUTER")])], {
      transport: async (request) => {
        sent.push(request);
        return reply(200, { data: {} });
      },
      now: NOW,
      schedule: {},
      readCredential: async (provider) => {
        asked.push(provider);
        return credential();
      }
    });
    expect(asked).toEqual(["OPENROUTER"]);
    expect(sent[0] !== undefined && sent[0].kind === undefined ? sent[0].url : undefined).toBe("https://openrouter.ai/api/v1/key");
  });

  it("drops a reading that survives parsing and fails validation", async () => {
    const result = await runAcquisition(
      [kimiSpec(() => [{ ...meter("KIMI"), value: 4_000 }])],
      {
        transport: async () => reply(200, {}),
        now: NOW,
        schedule: {},
        readCredential: async () => credential()
      }
    );
    expect(result.reports).toEqual([]);
    expect(result.schedule["KIMI"]?.outcome).toBe("drift");
  });

  it("says how every provider is read, in words with no dashes", () => {
    for (const sentence of Object.values(ACQUISITION_DISCLOSURE)) {
      expect(sentence).not.toMatch(/[-â€“â€”]/u);
      expect(sentence.length).toBeGreaterThan(0);
    }
    for (const sentence of Object.values(CREDENTIAL_FAILURE_SENTENCE)) {
      expect(sentence).not.toMatch(/[-â€“â€”]/u);
    }
    /* Every credential here was issued to another client, and every row says
       so before a person leans on the number. */
    expect(ACQUISITION_DISCLOSURE.claude).toContain("recorded choice");
    expect(ACQUISITION_DISCLOSURE.claude).not.toContain("off unless you turn it on");
  });

  it("records five separately thrown credential reads at their own instants, phase and class", async () => {
    /*
     * Astra's first reproduction: every outer catch stamped the round's start,
     * so five unrelated failures looked like one shared event. Each entry now
     * says when it failed, in which phase, and a code that never carries the
     * message (which could hold a path or a token).
     */
    let tick = Date.parse(NOW);
    const specs = [codexSpec(() => []), kimiSpec(() => []), grokSpec(() => []), openrouterSpec(() => []), geminiCliSpec(() => [])];
    const result = await runAcquisition(specs, {
      clock: () => (tick += 1_000),
      transport: async () => reply(200, {}),
      now: NOW,
      schedule: {},
      readCredential: async () => {
        throw Object.assign(new Error("could not open C:\\Users\\someone\\secret-token-value"), { code: "EACCES" });
      }
    });
    const entries = specs.map((spec) => result.schedule[spec.provider]);
    expect(new Set(entries.map((entry) => entry?.lastAttemptAt)).size).toBe(5);
    expect(entries.map((entry) => [entry?.phase, entry?.errorClass])).toEqual(
      specs.map(() => ["credential", "EACCES"])
    );
    expect(JSON.stringify(result.schedule)).not.toMatch(/secret|someone/u);
  });

  it("clears yesterday's drift when the OpenRouter key is now absent", async () => {
    /* Astra's second reproduction: the schedule started as a copy of the old
       one and an absent credential returned without touching its entry. */
    const result = await runAcquisition([openrouterSpec(() => [meter("OPENROUTER")])], {
      transport: async () => reply(200, {}),
      now: NOW,
      schedule: {
        OPENROUTER: { lastAttemptAt: "2025-12-31T09:00:00.000Z", nextAttemptAt: "2025-12-31T09:15:00.000Z", outcome: "drift" }
      },
      readCredential: async () => ({ ok: false, reason: "absent" })
    });
    expect(result.schedule["OPENROUTER"]).toBeUndefined();
    expect(result.rows[0]?.status).toBe("not_detected");
  });

  it("names the phase and class of every failure it records", async () => {
    const cases: readonly { reply: () => Promise<AcquisitionReply>; parse: () => RawMeter[] | null; phase: string; errorClass: string }[] = [
      { reply: async () => reply(429, {}), parse: () => [meter("KIMI")], phase: "request", errorClass: "rate_limited" },
      { reply: async () => ({ status: 200, body: "<html>", retryAfterSeconds: null }), parse: () => [meter("KIMI")], phase: "parse", errorClass: "drift" },
      { reply: async () => reply(200, {}), parse: () => null, phase: "parse", errorClass: "drift" }
    ];
    for (const scenario of cases) {
      const result = await runAcquisition([kimiSpec(scenario.parse)], {
        transport: scenario.reply, now: NOW, schedule: {}, readCredential: async () => credential()
      });
      expect([result.schedule["KIMI"]?.phase, result.schedule["KIMI"]?.errorClass]).toEqual([scenario.phase, scenario.errorClass]);
    }
    const ok = await runAcquisition([kimiSpec(() => [meter("KIMI")])], {
      transport: async () => reply(200, {}), now: NOW, schedule: {}, readCredential: async () => credential()
    });
    expect(ok.schedule["KIMI"]?.errorClass).toBeUndefined();
  });

  it("maps an outcome onto the vocabulary the cache understands", () => {
    expect(collectionReasonFor("unauthorized")).toBe("authentication");
    expect(collectionReasonFor("rate_limited")).toBe("rate_limited");
    expect(collectionReasonFor("transport")).toBe("network");
    /* Drift is deliberately not mapped through: a suppression would withdraw
       rows another source on this machine had every right to write. */
    expect(collectionReasonFor("drift")).toBe("remote_error");
  });
});
