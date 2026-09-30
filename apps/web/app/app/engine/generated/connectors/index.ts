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
export * from "./cursor";
export * from "./contract-gate";
export * from "./fixtures";
export * from "./gemini-cli";
export * from "./grok";
export * from "./kimi";
export * from "./manual";
export * from "./opencode";
export * from "./openrouter";
export * from "./synthetic";
export * from "./zai";
export * from "./minimax";
export * from "./cline";
export * from "./augment";
export * from "./amp";
export * from "./kilo";
export * from "./copilot";

import { isEnabledProviderCode, type ConnectorContract } from "../core";
import { antigravityConnector } from "./antigravity";
import { claudeConnector } from "./claude";
import { codexConnector } from "./codex";
import { cursorConnector } from "./cursor";
import { geminiCliConnector } from "./gemini-cli";
import { grokConnector } from "./grok";
import { kimiConnector } from "./kimi";
import { manualConnector } from "./manual";
import { opencodeConnector } from "./opencode";
import { openrouterConnector } from "./openrouter";
import { syntheticConnector } from "./synthetic";
import { zaiConnector } from "./zai";
import { minimaxConnector } from "./minimax";
import { clineConnector } from "./cline";
import { augmentConnector } from "./augment";
import { ampConnector } from "./amp";
import { kiloConnector } from "./kilo";
import { copilotConnector } from "./copilot";

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
