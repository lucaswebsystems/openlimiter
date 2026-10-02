import { describe, expect, it } from "vitest";
import { providerName } from "../app/app/language";

describe("provider labels", () => {
  it("describes Grok's shared weekly pool", () => {
    expect(providerName("GROK")).toBe("Grok weekly usage across Grok products");
  });
});
