import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";

/** A foreign status line may not hold Claude's prompt open indefinitely. */
export const STATUSLINE_WRAPPER_TIMEOUT_MILLISECONDS = 2_000;

/** Quota capture is best effort and never gets a longer budget than the prompt. */
export const STATUSLINE_WRAPPER_INGEST_TIMEOUT_MILLISECONDS = 1_000;

export interface StatuslineWrapperResult {
  exitCode: number;
  stdout: Buffer;
  stderr: Buffer;
  timedOut: boolean;
}

export interface StatuslineWrapperOptions {
  ingest: (payload: Buffer) => Promise<unknown>;
  timeoutMilliseconds?: number;
  ingestTimeoutMilliseconds?: number;
  spawnCommand?: StatuslineWrapperSpawn;
}

export type StatuslineWrapperSpawn = (
  command: string
) => ChildProcessWithoutNullStreams;

/**
 * The settings writer uses this alphabet because every character is inert in
 * both POSIX shells and cmd.exe. The decoded text is still passed to the shell
 * as one untouched command string, so this transport does not reinterpret it.
 */
export function encodeWrappedStatuslineCommand(command: string): string {
  return Buffer.from(command, "utf8").toString("base64url");
}

/** Decode only canonical, unpadded base64url carrying valid UTF-8. */
export function decodeWrappedStatuslineCommand(encoded: string): string | null {
  if (encoded === "" || !/^[A-Za-z0-9_-]+$/.test(encoded)) return null;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) return null;
    const command = bytes.toString("utf8");
    if (command === "" || !Buffer.from(command, "utf8").equals(bytes)) return null;
    return command;
  } catch {
    return null;
  }
}

function quietDeadline(promise: Promise<unknown>, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    void promise.then(finish, finish);
  });
}

function runOriginalCommand(
  command: string,
  payload: Buffer,
  timeoutMilliseconds: number,
  spawnCommand: StatuslineWrapperSpawn
): Promise<StatuslineWrapperResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;
    let child: ChildProcessWithoutNullStreams;
    let timer: NodeJS.Timeout;

    const finish = (exitCode: number, timedOut: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
        timedOut
      });
    };

    try {
      child = spawnCommand(command);
    } catch {
      resolve({
        exitCode: 0,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
        timedOut: false
      });
      return;
    }

    child.stdout.on("data", (chunk: Buffer) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(Buffer.from(chunk)));
    child.stdin.on("error", () => {
      /* An original command that closes standard input early is still allowed. */
    });
    child.on("error", () => finish(0, false));
    child.on("close", (code) => finish(code ?? 0, false));

    timer = setTimeout(() => {
      /* Stop waiting before attempting cleanup. Destroying the inherited pipes
         prevents a grandchild from keeping this wrapper alive after its shell
         has been terminated. */
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
      child.kill();
      child.unref();
      finish(0, true);
    }, timeoutMilliseconds);

    child.stdin.end(payload);
  });
}

/**
 * Capture Claude's payload and preserve the foreign status line as the primary
 * operation. OpenLimiter ingestion runs beside it, is bounded, and is silent.
 */
export async function runStatuslineWrapper(
  payload: Buffer,
  originalCommand: string,
  options: StatuslineWrapperOptions
): Promise<StatuslineWrapperResult> {
  const ingestion = Promise.resolve()
    .then(() => options.ingest(payload))
    .catch(() => undefined);
  const original = runOriginalCommand(
    originalCommand,
    payload,
    options.timeoutMilliseconds ?? STATUSLINE_WRAPPER_TIMEOUT_MILLISECONDS,
    options.spawnCommand ?? ((command) => spawn(command, {
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }))
  );
  const result = await original;
  await quietDeadline(
    ingestion,
    options.ingestTimeoutMilliseconds ??
      STATUSLINE_WRAPPER_INGEST_TIMEOUT_MILLISECONDS
  );
  return result;
}
