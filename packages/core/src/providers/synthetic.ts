import type { WaveProviderDescriptor } from "./index.js";

/**
 * Synthetic, as the TypeScript side needs it. Lane P1a owns this file.
 *
 * `enabled` is the TypeScript half of the provider switch: the Rust half is
 * `ENABLED` in apps/desktop/src-tauri/src/providers/synthetic.rs and the registry
 * half is `enabled` in its spec. `intervalSeconds` equals `INTERVAL_SECONDS`
 * there. Tests hold both pairs equal.
 */
export const syntheticProvider = {
  code: "SYNTHETIC",
  enabled: false,
  intervalSeconds: 900,
  statuslineTag: "sy",
  statuslineClass: "subscription"
} as const satisfies WaveProviderDescriptor;
