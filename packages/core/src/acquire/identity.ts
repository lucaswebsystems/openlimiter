/**
 * Who OpenLimiter says it is on the wire.
 *
 * One string, one place, no exceptions. Every other quota monitor that reads a
 * vendor CLI's token also copies that CLI's user agent, so the vendor cannot
 * tell the two apart. That is impersonation, it is what the vendor terms
 * actually forbid, and it is the one line a product with a company behind it
 * may not cross. We identify as ourselves and accept whatever rate bucket that
 * puts us in.
 *
 * The version is a constant rather than a read of package.json, because this
 * module is bundled into a published package and a runtime file read would be
 * one more thing that can fail inside a status line. A test holds it to the
 * package's own version, so the constant cannot drift.
 */

/** The published version this build identifies as. */
import { createHash } from "node:crypto";
import type { ProviderCode } from "../types.js";

export const ACQUISITION_CLIENT_VERSION = "2.0.3";

/** The only user agent any acquisition request may carry. */
export const OPENLIMITER_USER_AGENT =
  "OpenLimiter/" + ACQUISITION_CLIENT_VERSION + " (+https://openlimiter.com)";

/** Mirrors provider_detection::opaque_account_id, including the zero separator. */
export function opaqueAccountId(provider: ProviderCode, material: string): string {
  const slug = provider.toLowerCase().replaceAll("_", "-");
  return slug + "-" + createHash("sha256").update(slug).update(new Uint8Array([0]))
    .update(material).digest("hex").slice(0, 24);
}

export const PROVIDER_SINGLETON_MATERIAL = "one-active-account-without-stable-identity";

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

function field(value: unknown, names: readonly string[]): string | null {
  const source = object(value);
  for (const name of names) {
    const found = source[name];
    if (typeof found === "string" && found.trim().length > 0 && Buffer.byteLength(found.trim()) <= 512 && !/[\u0000-\u001f\u007f]/u.test(found)) return found.trim();
  }
  return null;
}

export function jwtIdentity(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || token.length > 4096) return null;
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return field(claims, ["chatgpt_account_id", "account_id", "accountId", "organization_id", "organizationId"])
      ?? field(claims, ["sub", "user_id", "userId"]);
  } catch { return null; }
}

/** Header identity and cache identity are separate, matching Rust's provider_account_id. */
export function credentialProviderAccount(provider: ProviderCode, container: unknown, root: unknown, secret: string): string | null {
  const names = ["account_id", "accountId", "accountUuid", "workspace_id", "workspaceId", "user_id", "userId"];
  const explicit = field(container, names) ?? field(root, names);
  if (explicit !== null) return explicit;
  try {
    const parts = secret.split(".");
    if (parts.length !== 3 || secret.length > 4096) return null;
    const claims: unknown = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8"));
    return provider === "CODEX" ? field(claims, ["chatgpt_account_id", "account_id"])
      : provider === "GROK" ? field(claims, ["user_id", "userId", "sub"]) : null;
  } catch { return null; }
}

/** Capture at acquisition time. Never assign an old observation to the current login. */
export function credentialIdentityMaterial(container: unknown, root: unknown, secret: string, hint: string | null = null): string | null {
  const names = ["account_id", "accountId", "accountUuid", "workspace_id", "workspaceId", "user_id", "userId"];
  return field(container, names) ?? field(root, names) ?? hint ?? jwtIdentity(secret)
    ?? jwtIdentity(field(container, ["id_token", "idToken"]) ?? "");
}

export function acquisitionAccountId(provider: ProviderCode, credential: { accountId: string | null; secret: string; identityMaterial?: string | null; origin?: string }): string {
  if (provider === "ANTIGRAVITY" && credential.origin === "vendor_store") return opaqueAccountId(provider, PROVIDER_SINGLETON_MATERIAL);
  return opaqueAccountId(provider, credential.identityMaterial ?? credential.accountId ?? jwtIdentity(credential.secret) ?? PROVIDER_SINGLETON_MATERIAL);
}
