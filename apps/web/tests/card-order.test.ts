// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  cardOrderStorageKey,
  moveVisibleCard,
  pruneCardOrder,
  readCardOrder,
  reconcileCardOrder,
  visibleCardOrder,
  writeCardOrder,
  type CardOrderStorage,
} from "../app/app/card-order";

function memory(seed: Record<string, string> = {}): CardOrderStorage & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
  };
}

describe("provider card order", () => {
  it("keeps absent accounts in place and appends new accounts in provider order", () => {
    const order = reconcileCardOrder(["claude", "hidden", "codex"], ["codex", "claude", "gemini"]);
    expect(order).toEqual(["claude", "hidden", "codex", "gemini"]);
    expect(visibleCardOrder(order, ["codex", "claude", "gemini"])).toEqual(["claude", "codex", "gemini"]);
    expect(moveVisibleCard(order, ["claude", "codex", "gemini"], "codex", 0))
      .toEqual(["codex", "hidden", "claude", "gemini"]);
  });

  it("uses separate user, paired device and demo scopes", () => {
    expect(new Set([
      cardOrderStorageKey({ kind: "user", id: "one" }),
      cardOrderStorageKey({ kind: "paired", id: "one" }),
      cardOrderStorageKey({ kind: "demo" }),
    ]).size).toBe(3);
  });

  it("tolerates storage failures and never overwrites from an empty first render", () => {
    const failing: CardOrderStorage = {
      getItem: () => { throw new Error("refused"); },
      setItem: () => { throw new Error("refused"); },
    };
    expect(readCardOrder(failing, { kind: "demo" })).toEqual([]);
    expect(() => writeCardOrder(failing, { kind: "demo" }, ["a"], ["a"])).not.toThrow();

    const scope = { kind: "user", id: "saved" } as const;
    const store = memory({ [cardOrderStorageKey(scope)]: JSON.stringify(["b", "a"]) });
    writeCardOrder(store, scope, [], []);
    expect(readCardOrder(store, scope)).toEqual(["b", "a"]);
  });

  it("prunes only when given an authoritative removal list", () => {
    expect(pruneCardOrder(["a", "gone", "b"], ["a", "b"])).toEqual(["a", "b"]);
    expect(reconcileCardOrder(["a", "gone", "b"], ["a", "b"])).toEqual(["a", "gone", "b"]);
  });
});
