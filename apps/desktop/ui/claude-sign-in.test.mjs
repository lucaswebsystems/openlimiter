import assert from "node:assert/strict";
import test from "node:test";
import { useClaudeSignIn } from "./claude-sign-in.js";

test("the row click sets the direct check on, then repaints the menu switch, then reads once", async () => {
  const log = [];
  const done = await useClaudeSignIn({
    setPoll: async (enabled) => { log.push(["set", enabled]); return { ok: true }; },
    repaintMenu: async () => { log.push(["menu"]); },
    check: async (code) => { log.push(["check", code]); return true; },
  });
  assert.equal(done, true);
  assert.deepEqual(log, [["set", true], ["menu"], ["check", "CLAUDE"]]);
});

test("a refused setting reads nothing and reports the failure", async () => {
  const log = [];
  const done = await useClaudeSignIn({
    setPoll: async () => ({ ok: false }),
    repaintMenu: async () => { log.push("menu"); },
    check: async () => { log.push("check"); return true; },
  });
  assert.equal(done, false);
  assert.deepEqual(log, []);
});
