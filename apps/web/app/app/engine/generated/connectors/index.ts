/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
export * from "./antigravity";
export * from "./claude";
export * from "./codex";
export * from "./fixtures";
export * from "./manual";
export * from "./opencode";
export * from "./openrouter";

import type { ConnectorContract } from "../core";
import { antigravityConnector } from "./antigravity";
import { claudeConnector } from "./claude";
import { codexConnector } from "./codex";
import { manualConnector } from "./manual";
import { opencodeConnector } from "./opencode";
import { openrouterConnector } from "./openrouter";

export const connectors: readonly ConnectorContract[] = [
  claudeConnector,
  openrouterConnector,
  codexConnector,
  antigravityConnector,
  opencodeConnector,
  manualConnector
];
