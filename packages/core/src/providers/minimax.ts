import type { WaveProviderDescriptor } from "./index.js";

/**
 * MiniMax, as the TypeScript side needs it. Lane P1b owns this file.
 *
 * `enabled` is the TypeScript half of the provider switch: the Rust half is
 * `ENABLED` in apps/desktop/src-tauri/src/providers/minimax.rs and the registry
 * half is `enabled` in its spec. `intervalSeconds` equals `INTERVAL_SECONDS`
 * there. Tests hold both pairs equal.
 */
export const minimaxProvider = {
  code: "MINIMAX",
  enabled: false,
  intervalSeconds: 900,
  statuslineTag: "mm",
  statuslineClass: "subscription"
} as const satisfies WaveProviderDescriptor;
