import { spawn } from "node:child_process";
import { ACQUISITION_CLIENT_VERSION } from "./identity.js";
import { opaqueAccountId } from "./identity.js";
import type {
  AcquisitionReply,
  CodexAppServerAcquisitionRequest
} from "./transport.js";

export const CODEX_APP_SERVER_TIMEOUT_MILLISECONDS = 5_000;
export const MAX_CODEX_APP_SERVER_OUTPUT_BYTES = 1_048_576;

export const CODEX_APP_SERVER_CLIENT_INFO = {
  name: "openlimiter",
  title: "OpenLimiter",
  version: ACQUISITION_CLIENT_VERSION
} as const;

export type CodexRateLimitsReadResult =
  | { readonly ok: true; readonly payload: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly reason:
        | "needs_sign_in"
        | "identity_mismatch"
        | "timeout"
        | "unavailable"
        | "protocol";
    };

export interface CodexRateLimitsReadOptions {
  readonly executable: string;
  readonly codexHome: string;
  readonly expectedAccountId: string;
  readonly argumentsPrefix?: readonly string[];
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMilliseconds?: number;
  readonly cwd?: string;
}

export function codexAppServerRequest(
  executable: string,
  codexHome: string,
  expectedAccountId: string,
  options: Pick<CodexRateLimitsReadOptions, "argumentsPrefix" | "environment" | "timeoutMilliseconds"> = {}
): CodexAppServerAcquisitionRequest | null {
  if (executable.length === 0 || codexHome.length === 0 || expectedAccountId.length === 0) {
    return null;
  }
  return {
    kind: "codex_app_server",
    endpoint: "codex_usage",
    executable,
    codexHome,
    expectedAccountId,
    ...(options.argumentsPrefix === undefined ? {} : { argumentsPrefix: options.argumentsPrefix }),
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
      body: JSON.stringify(result.payload),
      retryAfterSeconds: null
    };
  }
  if (result.reason === "needs_sign_in") {
    return { status: 401, body: "", retryAfterSeconds: null };
  }
  if (result.reason === "identity_mismatch") {
    return {
      status: 409,
      body: "",
      retryAfterSeconds: null,
      outcome: "identity_refused"
    };
  }
  throw new Error("Codex app server transport failed");
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function authenticationRequired(error: unknown): boolean {
  const value = object(error);
  return value?.["code"] === -32600 &&
    value["message"] === "chatgpt authentication required to read rate limits";
}

function validAccountId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

/** Read the documented Codex rate limit RPC over its JSONL stdio transport. */
export async function readCodexRateLimits(
  options: CodexRateLimitsReadOptions
): Promise<CodexRateLimitsReadResult> {
  const timeoutMilliseconds = options.timeoutMilliseconds ??
    CODEX_APP_SERVER_TIMEOUT_MILLISECONDS;
  if (
    options.executable.length === 0 ||
    options.codexHome.length === 0 ||
    options.expectedAccountId.length === 0 ||
    !Number.isSafeInteger(timeoutMilliseconds) ||
    timeoutMilliseconds <= 0
  ) return { ok: false, reason: "unavailable" };

  return await new Promise((resolve) => {
    let settled = false;
    let initialized = false;
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
            env: {
              ...(options.environment ?? process.env),
              CODEX_HOME: options.codexHome
            },
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
        send({ method: "account/rateLimits/read", id: 1 });
        return;
      }
      if (message["id"] !== 1 || !initialized) return;
      if (message["error"] !== undefined) {
        finish({
          ok: false,
          reason: authenticationRequired(message["error"]) ? "needs_sign_in" : "protocol"
        });
        return;
      }
      const result = object(message["result"]);
      if (result === null || object(result["rateLimits"]) === null) {
        finish({ ok: false, reason: "protocol" });
        return;
      }
      const statedAccountId = result["accountId"];
      if (statedAccountId !== undefined && statedAccountId !== null) {
        if (!validAccountId(statedAccountId)) {
          finish({ ok: false, reason: "protocol" });
          return;
        }
        if (opaqueAccountId("CODEX", statedAccountId) !== options.expectedAccountId) {
          finish({ ok: false, reason: "identity_mismatch" });
          return;
        }
      }
      finish({ ok: true, payload: result });
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
      if (receivedBytes > MAX_CODEX_APP_SERVER_OUTPUT_BYTES) {
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
