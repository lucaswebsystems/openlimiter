import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  unlink,
  type FileHandle
} from "node:fs/promises";
import path from "node:path";
import {
  PROVIDER_CODES,
  buildAdvice,
  canonicalJson,
  resolveStateDirectory,
  writeFileAtomically,
  type ProviderCode,
  type Snapshot
} from "@openlimiter/core";
import {
  SPILL_CONTEXT_NOTICE,
  UNTRUSTED_CONTEXT_CLOSE,
  UNTRUSTED_CONTEXT_NOTICE,
  UNTRUSTED_CONTEXT_OPEN,
  boundAgentContext,
  buildAgentContext
} from "./claude-code.js";
import {
  HOSTED_CONTEXT_MAX_BYTES,
  hostedPayloadLines,
  validateHostedContextBytes,
  type HostedContextTrust
} from "./hosted-context.js";

export const AGENT_CONTEXT_FILE_NAME = "openlimiter-agent-context.json";
export const AGENT_CONTEXT_SCHEMA = "openlimiter.agent_context";
export const AGENT_CONTEXT_VERSION = 1;
export const AGENT_CONTEXT_MAX_BYTES = 16_384;
export const AGENT_CONTEXT_MAX_AGE_MILLISECONDS = 15 * 60_000;
export const AGENT_CONTEXT_SPILL_FILE_NAME = "openlimiter-agent-context-spill.json";
export const AGENT_CONTEXT_SPILL_MAX_BYTES = 32_768;
export const HOSTED_CONTEXT_FILE_NAME = "openlimiter-pro-agent-context.json";

interface AgentContextDocument {
  schema: typeof AGENT_CONTEXT_SCHEMA;
  version: typeof AGENT_CONTEXT_VERSION;
  generated_at: string;
  expires_at: string;
  source: "cli_snapshot" | "validated_spill";
  untrusted_data: true;
  context: string;
}

type SafeBytes =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: "missing" | "oversized" | "unsafe" };

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

const openFlags = constants.O_RDONLY |
  (typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0);

async function pathContainsLink(target: string): Promise<boolean> {
  const resolved = path.resolve(target);
  const parsed = path.parse(resolved);
  let current = parsed.root;
  for (const segment of resolved.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) return true;
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      return true;
    }
  }
  return false;
}

async function readAtMost(handle: FileHandle, maximumBytes: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function readBytesSafely(file: string, maximumBytes: number): Promise<SafeBytes> {
  if (await pathContainsLink(file)) return { ok: false, reason: "unsafe" };
  let handle: FileHandle;
  try {
    handle = await open(file, openFlags);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { ok: false, reason: "missing" };
    return { ok: false, reason: "unsafe" };
  }
  try {
    const opened = await handle.stat();
    if (await pathContainsLink(file)) return { ok: false, reason: "unsafe" };
    if (!opened.isFile()) return { ok: false, reason: "unsafe" };
    if (opened.size > maximumBytes) return { ok: false, reason: "oversized" };
    const linked = await lstat(file);
    if (
      linked.isSymbolicLink() ||
      linked.dev !== opened.dev ||
      linked.ino !== opened.ino
    ) return { ok: false, reason: "unsafe" };
    const bytes = await readAtMost(handle, maximumBytes);
    return bytes.byteLength > maximumBytes
      ? { ok: false, reason: "oversized" }
      : { ok: true, bytes };
  } catch {
    return { ok: false, reason: "unsafe" };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function safeRemove(file: string): Promise<void> {
  try {
    if (await pathContainsLink(file)) return;
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return;
    await unlink(file);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  return actual.length === sorted.length && actual.every((key, index) => key === sorted[index]);
}

function exactInstant(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value;
}

const localProvider = new Set<string>(PROVIDER_CODES);
const localReason = new Set(["HEALTHY", "NEAR_CAP", "AT_CAP"]);
const localRecommendation = new Set(["PREFER", "NONE"]);
const localRecommendationReason = new Set([
  "LOWEST_USAGE",
  "ORDERED_TIE_BREAK",
  "NO_KNOWN_PROVIDER",
  "NO_FRESH_DATA",
  "NO_HEALTHY_PROVIDER"
]);
const hostedProvider = new Set([
  "ANTHROPIC", "CLAUDE", "CODEX", "GEMINI", "KIMI", "MANUAL", "OPENAI", "OPENCODE",
  "OPENROUTER", "XAI"
]);
const hostedMeter = new Set([
  "provider_usage_percent",
  "api_budget_percent"
]);
const hostedLevel = new Set(["60", "80", "90", "reset"]);
const hostedKind = new Set([
  "prefer_lower_cost_when_capable",
  "preserve_current_provider"
]);
const hostedReason = new Set([
  "high_usage", "budget_pressure", "normal"
]);

function validIsoOrNone(value: string): boolean {
  if (value === "NONE" || exactInstant(value)) return true;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString().replace(".000Z", "Z") === value;
}

function pairs(line: string): Map<string, string> | null {
  const fields = line.split(" ");
  const result = new Map<string, string>();
  for (const field of fields) {
    const separator = field.indexOf("=");
    if (separator <= 0 || separator === field.length - 1) return null;
    const key = field.slice(0, separator);
    if (result.has(key)) return null;
    result.set(key, field.slice(separator + 1));
  }
  return result;
}

function validRenderedLine(line: string): boolean {
  if (line === "schema=2" || line === SPILL_CONTEXT_NOTICE) return true;
  if (line.startsWith("reason=")) return localReason.has(line.slice(7));
  if (line.startsWith("recommendation_code=")) {
    return localRecommendation.has(line.slice("recommendation_code=".length));
  }
  if (line.startsWith("recommendation_provider=")) {
    const provider = line.slice("recommendation_provider=".length);
    return provider === "NONE" || localProvider.has(provider);
  }
  if (line.startsWith("recommendation_reason=")) {
    return localRecommendationReason.has(line.slice("recommendation_reason=".length));
  }
  if (line.startsWith("unknown=")) {
    const names = line.slice(8).split(",");
    return names.length <= PROVIDER_CODES.length &&
      names.every((name) => name === "NONE" || localProvider.has(name)) &&
      new Set(names).size === names.length;
  }
  if (line.startsWith("provider=")) {
    const fields = pairs(line);
    if (fields === null || [...fields.keys()].join(",") !==
      "provider,state,usage_percent,reset_at") return false;
    const usage = Number(fields.get("usage_percent"));
    return localProvider.has(fields.get("provider") ?? "") &&
      (fields.get("state") === "fresh" || fields.get("state") === "stale") &&
      Number.isFinite(usage) && usage >= 0 && usage <= 100 &&
      validIsoOrNone(fields.get("reset_at") ?? "");
  }
  if (line.startsWith("hosted_status ")) {
    const fields = pairs(line.slice("hosted_status ".length));
    if (fields === null || [...fields.keys()].join(",") !==
      "provider,meter,level,reset_at") return false;
    return hostedProvider.has(fields.get("provider") ?? "") &&
      hostedMeter.has(fields.get("meter") ?? "") &&
      hostedLevel.has(fields.get("level") ?? "") &&
      validIsoOrNone(fields.get("reset_at") ?? "");
  }
  if (line.startsWith("hosted_routing_hint ")) {
    const fields = pairs(line.slice("hosted_routing_hint ".length));
    if (fields === null || [...fields.keys()].join(",") !== "kind,provider,reason") return false;
    return hostedKind.has(fields.get("kind") ?? "") &&
      hostedProvider.has(fields.get("provider") ?? "") &&
      hostedReason.has(fields.get("reason") ?? "");
  }
  return false;
}

export function validatedUntrustedLines(context: string): string[] | null {
  if (
    context.includes("\r") ||
    context.includes("\0") ||
    Buffer.byteLength(context, "utf8") > AGENT_CONTEXT_SPILL_MAX_BYTES
  ) return null;
  const lines = context.split("\n");
  if (
    lines[0] !== UNTRUSTED_CONTEXT_OPEN ||
    lines[1] !== UNTRUSTED_CONTEXT_NOTICE ||
    lines.at(-1) !== UNTRUSTED_CONTEXT_CLOSE
  ) return null;
  const body = lines.slice(2, -1);
  return body.length > 0 && body.every(validRenderedLine) ? body : null;
}

function parseDocument(bytes: Buffer, now: string): AgentContextDocument | null {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value) || !exactKeys(value, [
    "context", "expires_at", "generated_at", "schema", "source", "untrusted_data", "version"
  ])) return null;
  if (
    value["schema"] !== AGENT_CONTEXT_SCHEMA ||
    value["version"] !== AGENT_CONTEXT_VERSION ||
    value["untrusted_data"] !== true ||
    (value["source"] !== "cli_snapshot" && value["source"] !== "validated_spill") ||
    !exactInstant(value["generated_at"]) ||
    !exactInstant(value["expires_at"]) ||
    typeof value["context"] !== "string" ||
    validatedUntrustedLines(value["context"]) === null
  ) return null;
  const generated = Date.parse(value["generated_at"]);
  const expires = Date.parse(value["expires_at"]);
  const current = Date.parse(now);
  if (
    !Number.isFinite(current) ||
    generated > current + 5 * 60_000 ||
    expires <= generated ||
    expires > generated + AGENT_CONTEXT_MAX_AGE_MILLISECONDS ||
    current >= expires
  ) return null;
  return value as unknown as AgentContextDocument;
}

async function writeDocument(
  file: string,
  source: AgentContextDocument["source"],
  context: string,
  generatedAt: string,
  expiresAt: string,
  maximumBytes: number
): Promise<void> {
  if (await pathContainsLink(file)) throw new Error("Unsafe agent context path");
  const document: AgentContextDocument = {
    schema: AGENT_CONTEXT_SCHEMA,
    version: AGENT_CONTEXT_VERSION,
    generated_at: generatedAt,
    expires_at: expiresAt,
    source,
    untrusted_data: true,
    context
  };
  const serialized = canonicalJson(document);
  if (Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw new Error("Agent context is larger than accepted");
  }
  await writeFileAtomically(file, serialized);
  if (await pathContainsLink(file)) {
    await safeRemove(file);
    throw new Error("Unsafe agent context path");
  }
  if (process.platform !== "win32") await chmod(file, 0o600);
}

function futureExpiry(snapshots: readonly Snapshot[], generated: number): number {
  const ceiling = generated + AGENT_CONTEXT_MAX_AGE_MILLISECONDS;
  const expiries = snapshots
    .map((snapshot) => Date.parse(snapshot.expiresAt))
    .filter((value) => Number.isFinite(value) && value > generated);
  return Math.min(ceiling, ...(expiries.length === 0 ? [ceiling] : expiries));
}

export async function writeAgentContextSnapshot(
  snapshots: readonly Snapshot[],
  directory: string | undefined,
  now: string,
  expectedProviders: readonly ProviderCode[] = PROVIDER_CODES
): Promise<void> {
  const base = directory ?? resolveStateDirectory();
  if (await pathContainsLink(base)) throw new Error("Unsafe agent context directory");
  await mkdir(base, { recursive: true, mode: 0o700 });
  if (await pathContainsLink(base)) throw new Error("Unsafe agent context directory");
  const file = path.join(base, AGENT_CONTEXT_FILE_NAME);
  const context = buildAgentContext(buildAdvice(snapshots, now, expectedProviders));
  const generated = Date.parse(now);
  if (context === "" || !Number.isFinite(generated)) {
    await safeRemove(file);
    return;
  }
  const expires = futureExpiry(snapshots, generated);
  if (expires <= generated) {
    await safeRemove(file);
    return;
  }
  await writeDocument(
    file,
    "cli_snapshot",
    context,
    new Date(generated).toISOString(),
    new Date(expires).toISOString(),
    AGENT_CONTEXT_MAX_BYTES
  );
}

async function localLines(directory: string, now: string): Promise<string[]> {
  const read = await readBytesSafely(
    path.join(directory, AGENT_CONTEXT_FILE_NAME),
    AGENT_CONTEXT_MAX_BYTES
  );
  if (!read.ok) {
    if (read.reason === "oversized") {
      await safeRemove(path.join(directory, AGENT_CONTEXT_FILE_NAME));
    }
    return [];
  }
  const document = parseDocument(read.bytes, now);
  if (document === null || document.source !== "cli_snapshot") {
    await safeRemove(path.join(directory, AGENT_CONTEXT_FILE_NAME));
    return [];
  }
  return validatedUntrustedLines(document.context) ?? [];
}

async function hostedLines(
  directory: string,
  now: string,
  trust: HostedContextTrust | undefined
): Promise<string[]> {
  if (trust === undefined) return [];
  const file = path.join(directory, HOSTED_CONTEXT_FILE_NAME);
  const read = await readBytesSafely(file, HOSTED_CONTEXT_MAX_BYTES);
  if (!read.ok) {
    if (read.reason === "oversized") await safeRemove(file);
    return [];
  }
  const validated = validateHostedContextBytes(read.bytes, { ...trust, now });
  if (!validated.ok) {
    await safeRemove(file);
    return [];
  }
  return hostedPayloadLines(validated.envelope).sort((left, right) => {
    const leftLevel = / level=(60|80|90|reset)/u.exec(left)?.[1];
    const rightLevel = / level=(60|80|90|reset)/u.exec(right)?.[1];
    if (leftLevel !== undefined || rightLevel !== undefined) {
      const severity = (level: string | undefined): number =>
        level === "reset" ? 0 : Number(level ?? -1);
      const difference = severity(rightLevel) - severity(leftLevel);
      if (difference !== 0) return difference;
      const reset = (line: string): number => {
        const value = / reset_at=([^ ]+)/u.exec(line)?.[1];
        if (value === undefined || value === "NONE") return Number.POSITIVE_INFINITY;
        const time = Date.parse(value);
        return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
      };
      const nearest = reset(left) - reset(right);
      if (nearest !== 0) return nearest;
    }
    return left.localeCompare(right);
  });
}

async function updateSpill(directory: string, context: string, now: string): Promise<void> {
  const file = path.join(directory, AGENT_CONTEXT_SPILL_FILE_NAME);
  if (context === "") {
    await safeRemove(file);
    return;
  }
  const generated = Date.parse(now);
  if (!Number.isFinite(generated)) return;
  await writeDocument(
    file,
    "validated_spill",
    context,
    new Date(generated).toISOString(),
    new Date(generated + AGENT_CONTEXT_MAX_AGE_MILLISECONDS).toISOString(),
    AGENT_CONTEXT_SPILL_MAX_BYTES
  );
}

function lineSeverity(line: string): number {
  const hosted = / level=(60|80|90|reset)(?: |$)/u.exec(line)?.[1];
  if (hosted !== undefined) return hosted === "reset" ? 0 : Number(hosted);
  const local = / usage_percent=(\d+(?:\.\d+)?)(?: |$)/u.exec(line)?.[1];
  return local === undefined ? -1 : Number(local);
}

function lineReset(line: string): number {
  const value = / reset_at=([^ ]+)(?: |$)/u.exec(line)?.[1];
  if (value === undefined || value === "NONE") return Number.POSITIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.POSITIVE_INFINITY;
}

function prioritizeOverflow(lines: readonly string[]): string[] {
  if (boundAgentContext(lines).spill === "") return [...lines];
  const indexed = lines.map((line, index) => ({ line, index }));
  const headers = indexed.filter(({ line }) =>
    !line.startsWith("provider=") &&
    !line.startsWith("hosted_status ") &&
    !line.startsWith("hosted_routing_hint ")
  );
  const statuses = indexed.filter(({ line }) =>
    line.startsWith("provider=") || line.startsWith("hosted_status ")
  );
  const highest = [...statuses].sort((left, right) =>
    lineSeverity(right.line) - lineSeverity(left.line) ||
    lineReset(left.line) - lineReset(right.line) ||
    left.index - right.index
  )[0];
  const nearest = [...statuses].sort((left, right) =>
    lineReset(left.line) - lineReset(right.line) ||
    lineSeverity(right.line) - lineSeverity(left.line) ||
    left.index - right.index
  ).find(({ index }) => index !== highest?.index &&
    Number.isFinite(lineReset(lines[index]!)));
  const routing = indexed.find(({ line }) => line.startsWith("hosted_routing_hint "));
  const priority = [
    ...headers,
    ...(highest === undefined ? [] : [highest]),
    ...(nearest === undefined ? [] : [nearest]),
    ...(routing === undefined ? [] : [routing])
  ];
  const selected = new Set(priority.map(({ index }) => index));
  return [
    ...priority.map(({ line }) => line),
    ...indexed.filter(({ index }) => !selected.has(index)).map(({ line }) => line)
  ];
}

export interface AgentContextReadOptions {
  hostedTrust?: HostedContextTrust;
}

export async function clearHostedAgentContext(directory?: string): Promise<void> {
  const base = directory ?? resolveStateDirectory();
  await Promise.all([
    safeRemove(path.join(base, HOSTED_CONTEXT_FILE_NAME)),
    safeRemove(path.join(base, AGENT_CONTEXT_SPILL_FILE_NAME))
  ]);
}

export async function agentContextFromCache(
  directory: string | undefined,
  now: string,
  _expectedProviders?: readonly ProviderCode[],
  options: AgentContextReadOptions = {}
): Promise<string> {
  const base = directory ?? resolveStateDirectory();
  const [local, hosted] = await Promise.all([
    localLines(base, now),
    hostedLines(base, now, options.hostedTrust)
  ]);
  if (local.length === 0 && hosted.length === 0) {
    await updateSpill(base, "", now);
    return "";
  }
  const bounded = boundAgentContext(prioritizeOverflow([...local, ...hosted]));
  await updateSpill(base, bounded.spill, now);
  return bounded.context;
}

export async function agentContextSpillFromCache(
  directory: string | undefined,
  now: string
): Promise<string> {
  const base = directory ?? resolveStateDirectory();
  const read = await readBytesSafely(
    path.join(base, AGENT_CONTEXT_SPILL_FILE_NAME),
    AGENT_CONTEXT_SPILL_MAX_BYTES
  );
  if (!read.ok) return "";
  const document = parseDocument(read.bytes, now);
  if (document?.source !== "validated_spill") {
    await safeRemove(path.join(base, AGENT_CONTEXT_SPILL_FILE_NAME));
    return "";
  }
  return document.context;
}
