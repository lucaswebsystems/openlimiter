/**
 * Generated file. Do not edit.
 *
 * Mirrored verbatim from the package source by app/app/engine/sync.mjs.
 * Only import specifiers were rewritten. Edit the package instead, then run
 * the script again.
 */
import type { WaveProviderDescriptor } from "./index";

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
