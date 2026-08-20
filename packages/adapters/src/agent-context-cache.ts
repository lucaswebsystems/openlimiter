import {
  buildAdvice,
  readJsonFileSafely,
  readSnapshotCache,
  resolveStateDirectory,
  type ProviderCode
} from "@openlimiter/core";
import path from "node:path";
import {
  buildAgentContext,
  hostedContextFromDocument
} from "./claude-code.js";

const HOSTED_CONTEXT_FILE_NAME = "openlimiter-pro-agent-context.json";

async function hostedContextFromCache(directory?: string): Promise<string> {
  const base = directory ?? resolveStateDirectory();
  const document = await readJsonFileSafely(
    path.join(base, HOSTED_CONTEXT_FILE_NAME),
    16_768
  );
  return document.ok ? hostedContextFromDocument(document.value) : "";
}

export async function agentContextFromCache(
  directory: string | undefined,
  now: string,
  expectedProviders?: readonly ProviderCode[]
): Promise<string> {
  const cached = await readSnapshotCache(directory);
  const local = cached.ok
    ? buildAgentContext(buildAdvice(cached.snapshots, now, expectedProviders))
    : "";
  const hosted = await hostedContextFromCache(directory);
  return [local, hosted].filter((context) => context !== "").join("\n");
}
