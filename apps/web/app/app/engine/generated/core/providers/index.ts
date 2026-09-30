/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
/**
 * The 2.1 providers, each described by the one file its own lane edits.
 *
 * Every shared table that needs a provider specific answer (whether it is
 * switched on, its cadence, its status line tag and class) reads it from
 * here, so a lane never edits a shared line to switch its provider on.
 */
import { syntheticProvider } from "./synthetic";
import { zaiProvider } from "./zai";
import { minimaxProvider } from "./minimax";
import { clineProvider } from "./cline";
import { augmentProvider } from "./augment";
import { ampProvider } from "./amp";
import { kiloProvider } from "./kilo";
import { copilotProvider } from "./copilot";

export interface WaveProviderDescriptor {
  readonly code: string;
  /** Whether this build has switched the provider on. */
  readonly enabled: boolean;
  /** Seconds between desktop reads, the cadence freshness is judged by. */
  readonly intervalSeconds: number;
  /** The two letter tag the status line draws. */
  readonly statuslineTag: string;
  /** Whether the status line reads it as a plan or as metered spend. */
  readonly statuslineClass: "subscription" | "api";
}

export const WAVE_PROVIDERS = [
  syntheticProvider,
  zaiProvider,
  minimaxProvider,
  clineProvider,
  augmentProvider,
  ampProvider,
  kiloProvider,
  copilotProvider
] as const;

export type WaveProviderCode = (typeof WAVE_PROVIDERS)[number]["code"];
