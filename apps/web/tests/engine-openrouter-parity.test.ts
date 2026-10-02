import { describe, expect, it } from "vitest";
import { parseOpenrouterPayload } from "../app/app/engine/generated/connectors/openrouter";

describe("generated OpenRouter mirror", () => {
  it("keeps the finite threshold at exactly ninety percent", () => {
    const parsed = parseOpenrouterPayload({
      data: { limit: 0.07, limit_remaining: 0.007, limit_reset: null, usage: 0 }
    }, "2026-08-07T12:00:00.000Z");
    expect(parsed?.[0]?.value).toBe(90);
  });
});
