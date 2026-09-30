import type { WaveProviderDescriptor } from "./index.js";

/**
 * Cline, as the TypeScript side needs it. Lane P1b owns this file.
 *
 * `enabled` is the TypeScript half of the provider switch: the Rust half is
 * `ENABLED` in apps/desktop/src-tauri/src/providers/cline.rs and the registry
 * half is `enabled` in its spec. `intervalSeconds` equals `INTERVAL_SECONDS`
 * there. Tests hold both pairs equal.
 */
export const clineProvider = {
  code: "CLINE",
  enabled: false,
  intervalSeconds: 900,
  statuslineTag: "cn",
  statuslineClass: "api"
} as const satisfies WaveProviderDescriptor;
