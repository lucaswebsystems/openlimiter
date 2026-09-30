export * from "./antigravity.js";
export * from "./claude.js";
export * from "./codex.js";
export * from "./cursor.js";
export * from "./contract-gate.js";
export * from "./fixtures.js";
export * from "./gemini-cli.js";
export * from "./grok.js";
export * from "./kimi.js";
export * from "./manual.js";
export * from "./opencode.js";
export * from "./openrouter.js";
export * from "./synthetic.js";
export * from "./zai.js";
export * from "./minimax.js";
export * from "./cline.js";
export * from "./augment.js";
export * from "./amp.js";
export * from "./kilo.js";
export * from "./copilot.js";

import { isEnabledProviderCode, type ConnectorContract } from "@openlimiter/core";
import { antigravityConnector } from "./antigravity.js";
import { claudeConnector } from "./claude.js";
import { codexConnector } from "./codex.js";
import { cursorConnector } from "./cursor.js";
import { geminiCliConnector } from "./gemini-cli.js";
import { grokConnector } from "./grok.js";
import { kimiConnector } from "./kimi.js";
import { manualConnector } from "./manual.js";
import { opencodeConnector } from "./opencode.js";
import { openrouterConnector } from "./openrouter.js";
import { syntheticConnector } from "./synthetic.js";
import { zaiConnector } from "./zai.js";
import { minimaxConnector } from "./minimax.js";
import { clineConnector } from "./cline.js";
import { augmentConnector } from "./augment.js";
import { ampConnector } from "./amp.js";
import { kiloConnector } from "./kilo.js";
import { copilotConnector } from "./copilot.js";

/**
 * Every connector this build switches on, in the order surfaces list them.
 *
 * The 2.1 connectors are registered here already, so their lanes write only
 * their own modules, and filtered out while their codes are pending: nothing
 * that iterates this list (detection, configuration rows, ingest, smoke runs)
 * learns they exist until the provider is switched on in core.
 */
export const connectors: readonly ConnectorContract[] = [
  claudeConnector,
  openrouterConnector,
  codexConnector,
  cursorConnector,
  antigravityConnector,
  geminiCliConnector,
  opencodeConnector,
  grokConnector,
  kimiConnector,
  manualConnector,
  syntheticConnector,
  zaiConnector,
  minimaxConnector,
  clineConnector,
  augmentConnector,
  ampConnector,
  kiloConnector,
  copilotConnector
].filter((connector) => isEnabledProviderCode(connector.id.toUpperCase()));
