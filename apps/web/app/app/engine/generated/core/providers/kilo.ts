/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import type { WaveProviderDescriptor } from "./index";

/**
 * Kilo Code, as the TypeScript side needs it. Lane P1c owns this file.
 *
 * `enabled` is the TypeScript half of the provider switch: the Rust half is
 * `ENABLED` in apps/desktop/src-tauri/src/providers/kilo.rs and the registry
 * half is `enabled` in its spec. `intervalSeconds` equals `INTERVAL_SECONDS`
 * there. Tests hold both pairs equal.
 */
export const kiloProvider = {
  code: "KILO",
  enabled: false,
  intervalSeconds: 900,
  statuslineTag: "kc",
  statuslineClass: "api"
} as const satisfies WaveProviderDescriptor;
