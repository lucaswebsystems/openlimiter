import type { WaveProviderDescriptor } from "./index.js";

/**
 * GitHub Copilot, as the TypeScript side needs it. Lane P1c owns this file.
 *
 * `enabled` is the TypeScript half of the provider switch: the Rust half is
 * `ENABLED` in apps/desktop/src-tauri/src/providers/copilot.rs and the registry
 * half is `enabled` in its spec. `intervalSeconds` equals `INTERVAL_SECONDS`
 * there. Tests hold both pairs equal.
 */
export const copilotProvider = {
  code: "COPILOT",
  enabled: false,
  intervalSeconds: 900,
  statuslineTag: "cp",
  statuslineClass: "subscription"
} as const satisfies WaveProviderDescriptor;
