import { spawn } from "node:child_process";
import type {
  AcquisitionReply,
  CodexAppServerAcquisitionRequest
} from "./transport.js";
import { opaqueAccountId } from "./identity.js";

export const CODEX_APP_SERVER_TIMEOUT_MILLISECONDS = 5_000;
const MAX_STDIO_BYTES = 1_048_576;

export const CODEX_APP_SERVER_CLIENT_INFO = {
  name: "openlimiter",
  title: "OpenLimiter",
  version: "2.0.3"
} as const;

export type CodexRateLimitsReadResult =
  | {
      readonly ok: true;
      readonly accountId: string | null;
      readonly payload: Record<string, unknown>;
    }
  | {
      readonly ok: false;
      readonly reason: "needs_sign_in" | "timeout" | "unavailable" | "protocol";
    };

export interface CodexRateLimitsReadOptions {
  readonly executable: string;
  readonly argumentsPrefix?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMilliseconds?: number;
  readonly cwd?: string;
}

export function codexAppServerRequest(
  executable: string,
  options: Omit<CodexRateLimitsReadOptions, "executable"> = {}
): CodexAppServerAcquisitionRequest | null {
  if (executable.length === 0) return null;
  return {
    kind: "codex_app_server",
    endpoint: "codex_app_server",
    url: "stdio:codex-app-server",
    method: "POST",
    headers: {},
    body: null,
    executable,
    ...(options.argumentsPrefix === undefined
      ? {}
      : { argumentsPrefix: options.argumentsPrefix }),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
    ...(options.timeoutMilliseconds === undefined
      ? {}
      : { timeoutMilliseconds: options.timeoutMilliseconds })
  };
}

export async function codexAppServerAcquisitionReply(
  request: CodexAppServerAcquisitionRequest
): Promise<AcquisitionReply> {
  const result = await readCodexRateLimits(request);
  if (result.ok) {
    return {
      status: 200,
      body: JSON.stringify({
        ...result.payload,
        ...(result.accountId === null ? {} : { accountId: result.accountId })
      }),
      retryAfterSeconds: null
    };
  }
  if (result.reason === "needs_sign_in") {
    return { status: 401, body: "", retryAfterSeconds: null };
  }
  if (result.reason === "protocol") {
    return { status: 502, body: "", retryAfterSeconds: null };
  }
  throw new Error("Codex app server unavailable");
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function signInError(value: unknown): boolean {
  const error = object(value);
  const message = error?.["message"];
  return typeof message === "string" &&
    (message === "chatgpt authentication required to read rate limits" ||
      message === "codex account authentication required to read rate limits");
}

/**
 * Read the stable Codex app-server account and rate limit RPCs over its default
 * JSONL stdio transport. Protocol pinned 2026-10-01:
 * https://learn.chatgpt.com/docs/app-server
 * https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol
 */
export async function readCodexRateLimits(
  options: CodexRateLimitsReadOptions
): Promise<CodexRateLimitsReadResult> {
  const timeoutMilliseconds = options.timeoutMilliseconds ??
    CODEX_APP_SERVER_TIMEOUT_MILLISECONDS;
  if (
    options.executable.length === 0 ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0
  ) return { ok: false, reason: "unavailable" };

  return await new Promise((resolve) => {
    let settled = false;
    let initialized = false;
    let workspaceAccountMaterial: string | null = null;
    let buffered = "";
    let receivedBytes = 0;
    const child = (() => {
      try {
        return spawn(
          options.executable,
          [...(options.argumentsPrefix ?? []), "app-server"],
          {
            shell: false,
            windowsHide: true,
            stdio: ["pipe", "pipe", "ignore"],
            ...(options.environment === undefined ? {} : { env: options.environment }),
            ...(options.cwd === undefined ? {} : { cwd: options.cwd })
          }
        );
      } catch {
        return null;
      }
    })();
    if (child === null) {
      resolve({ ok: false, reason: "unavailable" });
      return;
    }

    const finish = (result: CodexRateLimitsReadResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout.removeAllListeners();
      child.removeAllListeners();
      child.stdin.removeAllListeners();
      if (!child.stdin.destroyed) child.stdin.destroy();
      if (child.exitCode === null) child.kill();
      resolve(result);
    };
    const send = (message: unknown): boolean => {
      if (settled || child.stdin.destroyed) return false;
      child.stdin.write(JSON.stringify(message) + "\n", (error) => {
        if (error !== null && error !== undefined) {
          finish({ ok: false, reason: "unavailable" });
        }
      });
      return true;
    };
    const handle = (line: string): void => {
      let message: Record<string, unknown> | null;
      try {
        message = object(JSON.parse(line) as unknown);
      } catch {
        finish({ ok: false, reason: "protocol" });
        return;
      }
      if (message === null) return;
      if (message["id"] === 0) {
        if (object(message["error"]) !== null || object(message["result"]) === null) {
          finish({ ok: false, reason: "protocol" });
          return;
        }
        initialized = true;
        if (!send({ method: "initialized", params: {} })) return;
        send({ method: "account/read", id: 1, params: { refreshToken: false } });
        return;
      }
      if (message["id"] === 1 && initialized) {
        if (message["error"] !== undefined) {
          finish({ ok: false, reason: "protocol" });
          return;
        }
        const accountResult = object(message["result"]);
        const account = accountResult?.["account"];
        if (accountResult === null || (account !== null && object(account) === null)) {
          finish({ ok: false, reason: "protocol" });
          return;
        }
        const workspaceRouting = object(accountResult["workspaceRouting"]);
        const workspaceAccountId = workspaceRouting?.["chatgptAccountId"];
        workspaceAccountMaterial = typeof workspaceAccountId === "string" &&
            workspaceAccountId.length > 0 && workspaceAccountId.length <= 512 &&
            !/[\u0000-\u001f\u007f]/u.test(workspaceAccountId)
          ? workspaceAccountId
          : null;
        send({ method: "account/rateLimits/read", id: 2 });
        return;
      }
      if (message["id"] !== 2 || !initialized) return;
      if (message["error"] !== undefined) {
        finish({
          ok: false,
          reason: signInError(message["error"]) ? "needs_sign_in" : "protocol"
        });
        return;
      }
      const result = object(message["result"]);
      if (result === null || object(result["rateLimits"]) === null) {
        finish({ ok: false, reason: "protocol" });
        return;
      }
      /* Main 342f8cc hashed auth.json tokens.account_id. The documented
         rate limit response exposes that ChatGPT account material as accountId,
         so this preserves the exact opaque id without opening auth.json. */
      const material = result["accountId"] ?? workspaceAccountMaterial;
      const accountId = typeof material === "string" && material.length > 0 &&
          material.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(material)
        ? opaqueAccountId("CODEX", material)
        : null;
      finish({
        ok: true,
        accountId,
        payload: result
      });
    };
    const timer = setTimeout(
      () => finish({ ok: false, reason: "timeout" }),
      timeoutMilliseconds
    );

    child.once("error", () => finish({ ok: false, reason: "unavailable" }));
    child.stdin.once("error", () => finish({ ok: false, reason: "unavailable" }));
    child.once("close", () => {
      if (!settled) finish({ ok: false, reason: "unavailable" });
    });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (settled) return;
      receivedBytes += Buffer.byteLength(chunk);
      if (receivedBytes > MAX_STDIO_BYTES) {
        finish({ ok: false, reason: "protocol" });
        return;
      }
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf("\n");
        if (newline < 0) break;
        const line = buffered.slice(0, newline).replace(/\r$/u, "");
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) handle(line);
        if (settled) return;
      }
    });

    send({
      method: "initialize",
      id: 0,
      params: {
        clientInfo: CODEX_APP_SERVER_CLIENT_INFO,
        capabilities: { experimentalApi: true }
      }
    });
  });
}
