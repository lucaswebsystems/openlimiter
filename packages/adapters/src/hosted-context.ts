import { verify, type KeyLike } from "node:crypto";

export const HOSTED_CONTEXT_SCHEMA = "openlimiter.hosted_context";
export const HOSTED_CONTEXT_VERSION = 1;
export const HOSTED_CONTEXT_MAX_BYTES = 16_384;
export const HOSTED_SIGNED_PAYLOAD_MAX_BYTES = 12_288;
export const HOSTED_RECORD_LIMIT = 40;

const keyIdPattern = /^[A-Za-z0-9_.-]{1,64}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const providerNames = new Set([
  "anthropic",
  "claude",
  "codex",
  "gemini",
  "kimi",
  "manual",
  "openai",
  "opencode",
  "openrouter",
  "xai"
]);
const meterNames = new Set([
  "provider_usage_percent",
  "api_budget_percent"
]);
const levels = new Set(["60", "80", "90", "reset"]);
const hintKinds = new Set([
  "prefer_lower_cost_when_capable",
  "preserve_current_provider"
]);
const hintReasons = new Set([
  "high_usage",
  "budget_pressure",
  "normal"
]);

export interface HostedMeter {
  provider: string;
  meter: string;
  level: string;
  reset_at: string | null;
}

export interface HostedRoutingHint {
  kind: string;
  provider: string;
  reason: string;
}

export interface HostedContextEnvelope {
  schema: typeof HOSTED_CONTEXT_SCHEMA;
  version: typeof HOSTED_CONTEXT_VERSION;
  kid: string;
  generated_at: string;
  expires_at: string;
  account_id: string;
  device_id: string;
  revocation_epoch: number;
  source: {
    kind: "accepted_snapshot";
    event_id: string;
    sequence: number;
    observed_at: string;
  };
  payload: {
    meters: HostedMeter[];
    routing_hints: HostedRoutingHint[];
  };
  signature: string;
}

export interface HostedContextTrust {
  routingEnabled: boolean;
  accountId: string;
  deviceId: string;
  latestSequence: number;
  greatestAcceptedRevocationEpoch: number;
  currentHostedRevocationEpoch: number;
  publicKeys: Readonly<Record<string, KeyLike>>;
  now: string;
}

export type HostedContextRejection =
  | "account"
  | "device"
  | "disabled"
  | "encoding"
  | "epoch"
  | "expired"
  | "future"
  | "key"
  | "malformed"
  | "oversized"
  | "records"
  | "schema"
  | "sequence"
  | "signature"
  | "source_stale"
  | "time";

export type HostedContextValidation =
  | { ok: true; envelope: HostedContextEnvelope }
  | { ok: false; reason: HostedContextRejection };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

function wellFormedUnicode(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

class StrictJsonParser {
  private index = 0;

  constructor(private readonly text: string) {}

  parse(): unknown {
    const value = this.value();
    this.whitespace();
    if (this.index !== this.text.length) throw new Error("trailing JSON");
    return value;
  }

  private whitespace(): void {
    while (/\s/u.test(this.text[this.index] ?? "") &&
      " \t\r\n".includes(this.text[this.index] ?? "")) this.index += 1;
  }

  private value(): unknown {
    this.whitespace();
    const character = this.text[this.index];
    if (character === "{") return this.object();
    if (character === "[") return this.array();
    if (character === "\"") return this.string();
    if (this.text.startsWith("true", this.index)) {
      this.index += 4;
      return true;
    }
    if (this.text.startsWith("false", this.index)) {
      this.index += 5;
      return false;
    }
    if (this.text.startsWith("null", this.index)) {
      this.index += 4;
      return null;
    }
    return this.number();
  }

  private object(): Record<string, unknown> {
    this.index += 1;
    this.whitespace();
    const entries: [string, unknown][] = [];
    const keys = new Set<string>();
    if (this.text[this.index] === "}") {
      this.index += 1;
      return {};
    }
    while (true) {
      if (this.text[this.index] !== "\"") throw new Error("object key");
      const key = this.string();
      if (keys.has(key)) throw new Error("duplicate key");
      keys.add(key);
      this.whitespace();
      if (this.text[this.index] !== ":") throw new Error("object colon");
      this.index += 1;
      entries.push([key, this.value()]);
      this.whitespace();
      if (this.text[this.index] === "}") {
        this.index += 1;
        return Object.fromEntries(entries) as Record<string, unknown>;
      }
      if (this.text[this.index] !== ",") throw new Error("object comma");
      this.index += 1;
      this.whitespace();
    }
  }

  private array(): unknown[] {
    this.index += 1;
    this.whitespace();
    const values: unknown[] = [];
    if (this.text[this.index] === "]") {
      this.index += 1;
      return values;
    }
    while (true) {
      values.push(this.value());
      this.whitespace();
      if (this.text[this.index] === "]") {
        this.index += 1;
        return values;
      }
      if (this.text[this.index] !== ",") throw new Error("array comma");
      this.index += 1;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    let escaped = false;
    while (this.index < this.text.length) {
      const character = this.text[this.index]!;
      const unit = this.text.charCodeAt(this.index);
      if (!escaped && character === "\"") {
        this.index += 1;
        const parsed = JSON.parse(this.text.slice(start, this.index)) as unknown;
        if (typeof parsed !== "string" || !wellFormedUnicode(parsed)) {
          throw new Error("unicode");
        }
        return parsed;
      }
      if (!escaped && unit < 0x20) throw new Error("control character");
      if (!escaped && character === "\\") {
        escaped = true;
      } else {
        escaped = false;
      }
      this.index += 1;
    }
    throw new Error("unterminated string");
  }

  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(
      this.text.slice(this.index)
    );
    if (match === null) throw new Error("number");
    const token = match[0];
    const value = Number(token);
    if (!Number.isFinite(value) || JSON.stringify(value) !== token) {
      throw new Error("noncanonical number");
    }
    this.index += token.length;
    return value;
  }
}

function strictJson(text: string): unknown {
  return new StrictJsonParser(text).parse();
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (!isRecord(value)) throw new Error("value");
  return "{" + Object.keys(value).sort().map((key) =>
    JSON.stringify(key) + ":" + canonical(value[key])
  ).join(",") + "}";
}

function instant(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value)
  ) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  const canonical = new Date(time).toISOString();
  return value === canonical || value === canonical.replace(".000Z", "Z");
}

function safeIdentifier(value: unknown): value is string {
  return typeof value === "string" && keyIdPattern.test(value);
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && uuidPattern.test(value);
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function positiveInteger(value: unknown): value is number {
  return integer(value) && value > 0;
}

function validMeter(value: unknown): value is HostedMeter {
  if (!isRecord(value) || !exactKeys(value, ["level", "meter", "provider", "reset_at"])) {
    return false;
  }
  return typeof value["provider"] === "string" && providerNames.has(value["provider"]) &&
    typeof value["meter"] === "string" && meterNames.has(value["meter"]) &&
    typeof value["level"] === "string" && levels.has(value["level"]) &&
    (value["reset_at"] === null || instant(value["reset_at"]));
}

function validHint(value: unknown): value is HostedRoutingHint {
  if (!isRecord(value) || !exactKeys(value, ["kind", "provider", "reason"])) return false;
  return typeof value["kind"] === "string" && hintKinds.has(value["kind"]) &&
    typeof value["provider"] === "string" && providerNames.has(value["provider"]) &&
    typeof value["reason"] === "string" && hintReasons.has(value["reason"]);
}

function decodeSignature(value: string): Buffer | null {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.length === 64 && bytes.toString("base64url") === value ? bytes : null;
  } catch {
    return null;
  }
}

function envelopeFromUnknown(value: unknown): HostedContextEnvelope | null {
  if (!isRecord(value) || !exactKeys(value, [
    "account_id",
    "device_id",
    "expires_at",
    "generated_at",
    "kid",
    "payload",
    "revocation_epoch",
    "schema",
    "signature",
    "source",
    "version"
  ])) return null;
  const source = value["source"];
  const payload = value["payload"];
  if (!isRecord(source) || !exactKeys(source, [
    "event_id", "kind", "observed_at", "sequence"
  ])) return null;
  if (!isRecord(payload) || !exactKeys(payload, ["meters", "routing_hints"])) return null;
  const meters = payload["meters"];
  const hints = payload["routing_hints"];
  if (!Array.isArray(meters) || !Array.isArray(hints)) return null;
  if (
    value["schema"] !== HOSTED_CONTEXT_SCHEMA ||
    value["version"] !== HOSTED_CONTEXT_VERSION ||
    !safeIdentifier(value["kid"]) ||
    !instant(value["generated_at"]) ||
    !instant(value["expires_at"]) ||
    !uuid(value["account_id"]) ||
    !uuid(value["device_id"]) ||
    !integer(value["revocation_epoch"]) ||
    value["signature"] === undefined ||
    typeof value["signature"] !== "string" ||
    source["kind"] !== "accepted_snapshot" ||
    !uuid(source["event_id"]) ||
    !positiveInteger(source["sequence"]) ||
    !instant(source["observed_at"]) ||
    !meters.every(validMeter) ||
    !hints.every(validHint)
  ) return null;
  return value as unknown as HostedContextEnvelope;
}

export function validateHostedContextBytes(
  bytes: Uint8Array | string,
  trust: HostedContextTrust
): HostedContextValidation {
  if (!trust.routingEnabled) return { ok: false, reason: "disabled" };
  const buffer = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
  if (buffer.byteLength > HOSTED_CONTEXT_MAX_BYTES) return { ok: false, reason: "oversized" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return { ok: false, reason: "encoding" };
  }
  let parsed: unknown;
  try {
    parsed = strictJson(text);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const envelope = envelopeFromUnknown(parsed);
  if (envelope === null) return { ok: false, reason: "schema" };
  if (envelope.payload.meters.length + envelope.payload.routing_hints.length > HOSTED_RECORD_LIMIT) {
    return { ok: false, reason: "records" };
  }
  const signature = decodeSignature(envelope.signature);
  if (signature === null) return { ok: false, reason: "signature" };
  const key = trust.publicKeys[envelope.kid];
  if (key === undefined) return { ok: false, reason: "key" };
  const { signature: _signature, ...unsigned } = envelope;
  let signed: string;
  try {
    signed = canonical(unsigned);
  } catch {
    return { ok: false, reason: "schema" };
  }
  if (Buffer.byteLength(signed, "utf8") > HOSTED_SIGNED_PAYLOAD_MAX_BYTES) {
    return { ok: false, reason: "oversized" };
  }
  try {
    if (!verify(null, Buffer.from(signed, "utf8"), key, signature)) {
      return { ok: false, reason: "signature" };
    }
  } catch {
    return { ok: false, reason: "signature" };
  }
  const now = Date.parse(trust.now);
  const generated = Date.parse(envelope.generated_at);
  const expires = Date.parse(envelope.expires_at);
  const observed = Date.parse(envelope.source.observed_at);
  if (![now, generated, expires, observed].every(Number.isFinite)) {
    return { ok: false, reason: "time" };
  }
  if (generated > now + 5 * 60_000) return { ok: false, reason: "future" };
  if (expires <= generated || expires > generated + 15 * 60_000) {
    return { ok: false, reason: "time" };
  }
  if (now >= expires) return { ok: false, reason: "expired" };
  if (observed > generated || observed < generated - 30 * 60_000) {
    return { ok: false, reason: "source_stale" };
  }
  if (envelope.account_id !== trust.accountId) return { ok: false, reason: "account" };
  if (envelope.device_id !== trust.deviceId) return { ok: false, reason: "device" };
  if (envelope.source.sequence !== trust.latestSequence) {
    return { ok: false, reason: "sequence" };
  }
  if (
    envelope.revocation_epoch !== trust.greatestAcceptedRevocationEpoch ||
    envelope.revocation_epoch !== trust.currentHostedRevocationEpoch
  ) return { ok: false, reason: "epoch" };
  return { ok: true, envelope };
}

export function hostedPayloadLines(envelope: HostedContextEnvelope): string[] {
  return [
    ...envelope.payload.meters.map((meter) => [
      "hosted_status",
      "provider=" + meter.provider.toUpperCase(),
      "meter=" + meter.meter,
      "level=" + meter.level,
      "reset_at=" + (meter.reset_at ?? "NONE")
    ].join(" ")),
    ...envelope.payload.routing_hints.map((hint) => [
      "hosted_routing_hint",
      "kind=" + hint.kind,
      "provider=" + hint.provider.toUpperCase(),
      "reason=" + hint.reason
    ].join(" "))
  ];
}

export function canonicalHostedContext(value: Omit<HostedContextEnvelope, "signature">): string {
  return canonical(value);
}
