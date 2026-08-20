export * from "./antigravity.js";
export * from "./claude.js";
export * from "./codex.js";
export * from "./contract-gate.js";
export * from "./fixtures.js";
export * from "./grok.js";
export * from "./kimi.js";
export * from "./manual.js";
export * from "./opencode.js";
export * from "./openrouter.js";

import type { ConnectorContract } from "@openlimiter/core";
import { antigravityConnector } from "./antigravity.js";
import { claudeConnector } from "./claude.js";
import { codexConnector } from "./codex.js";
import { grokConnector } from "./grok.js";
import { kimiConnector } from "./kimi.js";
import { manualConnector } from "./manual.js";
import { opencodeConnector } from "./opencode.js";
import { openrouterConnector } from "./openrouter.js";

export const connectors: readonly ConnectorContract[] = [
  claudeConnector,
  openrouterConnector,
  codexConnector,
  antigravityConnector,
  opencodeConnector,
  grokConnector,
  kimiConnector,
  manualConnector
];
