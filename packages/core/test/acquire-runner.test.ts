import { describe, expect, it } from "vitest";
import {
  ACQUISITION_BLOCKED_BACKOFF_SECONDS,
  ACQUISITION_DISCLOSURE,
  ACQUISITION_INTERVAL_SECONDS,
  CODE_ASSIST_TIERS_FIELD,
  SHARED_CODE_ASSIST_LABEL,
  CODE_ASSIST_IDENTITY_SENTENCE,
  CODE_ASSIST_PROJECT_FIELD,
  CREDENTIAL_FAILURE_SENTENCE,
  SHARED_CODE_ASSIST_ACCOUNT,
  antigravitySpec,
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
  origin: "vendor_file" | "vendor_store" | "shared_code_assist" | "user_key" =
    "vendor_file"
): CredentialResult {
  return {
    ok: true,
    credential: {
      secret: SYNTHETIC_TOKEN,
      accountId,
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
        return reply(200, { rate_limit: {} });
      },
      now: NOW,
      schedule: {},
      readCredential: async () => credential("acct-1"),
      stamp: (meters) => meters.map((entry) => ({ ...entry, writer: "cli" }))
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.url).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(sent[0]?.headers["chatgpt-account-id"]).toBe("acct-1");
    expect(result.rows).toEqual([{
      provider: "CODEX",
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

  it("backs off an hour on a rate limit and a day on a refusal", async () => {
    const rateLimited = await runAcquisition([grokSpec(() => [meter("GROK")])], {
      transport: async () => reply(429, {}),
      now: NOW,
      schedule: {},
      readCredential: async () => credential("user-1")
    });
    expect(rateLimited.rows[0]?.status).toBe("stale");
    expect(rateLimited.rows[0]?.nextAttemptAt).toBe("2026-01-01T01:00:00.000Z");
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
    expect(sent[0]?.url).toBe("https://api.anthropic.com/api/oauth/usage");
    expect(sent[0]?.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
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
    expect(sent[1]?.body).toContain("managed-project-123");
    expect(result.rows[0]?.status).toBe("read");
  });

  it("names a provider that answers only its own tools, and waits a day", async () => {
    /*
     * Measured live on 2026-09-07: loadCodeAssist answered 200 to a request
     * identifying as OpenLimiter and returned allowedTiers and ineligibleTiers
     * and no companion project. That is not drift, nothing changed shape, and
     * retrying it every fifteen minutes would be ninety six requests a day
     * against an answer that cannot differ until we change identity, which
     * Rule 1 forbids.
     */
    const sent: AcquisitionRequest[] = [];
    const result = await runAcquisition([antigravitySpec(() => [meter("ANTIGRAVITY")])], {
      transport: async (request) => {
        sent.push(request);
        return reply(200, {
          allowedTiers: [{ id: "free-tier", isDefault: true }],
          ineligibleTiers: [{ reasonCode: "RESTRICTED", tierId: "standard-tier" }]
        });
      },
      now: NOW,
      schedule: {},
      readCredential: async () => credential()
    });
    expect(sent).toHaveLength(1);
    expect(result.schedule["ANTIGRAVITY"]?.outcome).toBe("identity_refused");
    expect(result.rows[0]?.reason).toBe(CODE_ASSIST_IDENTITY_SENTENCE);
    expect(result.rows[0]?.nextAttemptAt).toBe("2026-01-02T00:00:00.000Z");
    expect(ACQUISITION_BLOCKED_BACKOFF_SECONDS).toBe(86_400);
  });

  it("keeps every other Code Assist failure transient", async () => {
    /*
     * A day of silence is bought on ONE measured signature and nothing else.
     * Everything below is a provider having a bad hour, and a bad hour must
     * never cost a day.
     */
    const cases: {
      readonly name: string;
      readonly reply: () => Promise<AcquisitionReply>;
      readonly outcome: string;
      readonly next: string;
    }[] = [
      {
        name: "a bootstrap with neither field",
        reply: async () => reply(200, { unexpected: true }),
        outcome: "drift",
        next: "2026-01-01T00:15:00.000Z"
      },
      {
        name: "a body that is not an object",
        reply: async () => reply(200, ["not an object at all"]),
        outcome: "drift",
        next: "2026-01-01T00:15:00.000Z"
      },
      {
        name: "a server error",
        reply: async () => ({ status: 500, body: "", retryAfterSeconds: null }),
        outcome: "remote_error",
        next: "2026-01-01T00:15:00.000Z"
      },
      {
        name: "a rate limit",
        reply: async () => ({ status: 429, body: "", retryAfterSeconds: null }),
        outcome: "rate_limited",
        next: "2026-01-01T01:00:00.000Z"
      },
      {
        name: "a body that is not JSON",
        reply: async () => ({ status: 200, body: "<html>", retryAfterSeconds: null }),
        outcome: "drift",
        next: "2026-01-01T00:15:00.000Z"
      }
    ];
    for (const scenario of cases) {
      const result = await runAcquisition(
        [antigravitySpec(() => [meter("ANTIGRAVITY")])],
        {
          transport: scenario.reply,
          now: NOW,
          schedule: {},
          readCredential: async () => credential()
        }
      );
      expect(
        result.schedule["ANTIGRAVITY"]?.outcome,
        scenario.name
      ).toBe(scenario.outcome);
      expect(result.rows[0]?.nextAttemptAt, scenario.name).toBe(scenario.next);
    }
    expect(ACQUISITION_INTERVAL_SECONDS).toBe(900);
  });

  it("reads the refusal only from the tier list beside a missing project", async () => {
    const refused = await runAcquisition(
      [antigravitySpec(() => [meter("ANTIGRAVITY")])],
      {
        transport: async () => reply(200, { [CODE_ASSIST_TIERS_FIELD]: [] }),
        now: NOW,
        schedule: {},
        readCredential: async () => credential()
      }
    );
    expect(refused.schedule["ANTIGRAVITY"]?.outcome).toBe("identity_refused");
  });

  it("files a borrowed Gemini login under its own account, never Antigravity's", async () => {
    const result = await runAcquisition([antigravitySpec(() => [meter("ANTIGRAVITY")])], {
      transport: async (request) => request.endpoint === "code_assist_load"
        ? reply(200, { [CODE_ASSIST_PROJECT_FIELD]: "managed-project-123" })
        : reply(200, { buckets: [] }),
      now: NOW,
      schedule: {},
      readCredential: async () => credential(null, "shared_code_assist")
    });
    expect(result.rows[0]).toMatchObject({
      status: "read",
      accountId: SHARED_CODE_ASSIST_ACCOUNT,
      disclosure: ACQUISITION_DISCLOSURE.antigravityShared
    });
    /* The identifier keys the cache; the label is what a person should read
       where a surface would otherwise print "gemini-cli-shared". */
    const first = result.reports[0];
    expect(first?.ok === true ? first.snapshots[0]?.accountLabel : null).toBe(
      SHARED_CODE_ASSIST_LABEL
    );
    expect(SHARED_CODE_ASSIST_LABEL).toBe("Shared Google Code Assist quota");
    const report = result.reports[0];
    expect(report?.ok === true ? report.accountId : null).toBe(
      SHARED_CODE_ASSIST_ACCOUNT
    );
    expect(report?.ok === true ? report.snapshots[0]?.accountId : null).toBe(
      SHARED_CODE_ASSIST_ACCOUNT
    );
  });

  it("keeps Antigravity's own login unlabelled", async () => {
    const result = await runAcquisition([antigravitySpec(() => [meter("ANTIGRAVITY")])], {
      transport: async (request) => request.endpoint === "code_assist_load"
        ? reply(200, { [CODE_ASSIST_PROJECT_FIELD]: "managed-project-123" })
        : reply(200, { buckets: [] }),
      now: NOW,
      schedule: {},
      readCredential: async () => credential(null, "vendor_store")
    });
    expect(result.rows[0]?.accountId).toBeUndefined();
    expect(result.rows[0]?.disclosure).toBe(ACQUISITION_DISCLOSURE.antigravity);
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
    expect(sent[0]?.url).toBe("https://openrouter.ai/api/v1/key");
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
      expect(sentence).not.toMatch(/[-–—]/u);
      expect(sentence.length).toBeGreaterThan(0);
    }
    for (const sentence of Object.values(CREDENTIAL_FAILURE_SENTENCE)) {
      expect(sentence).not.toMatch(/[-–—]/u);
    }
    /* Every credential here was issued to somebody else's client, and every
       row says so before a person leans on the number. */
    expect(ACQUISITION_DISCLOSURE.antigravity).toContain(
      "reads the credential the Antigravity CLI stored"
    );
    expect(ACQUISITION_DISCLOSURE.claude).toContain("off unless you turn it on");
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
