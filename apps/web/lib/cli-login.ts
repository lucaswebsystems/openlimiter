import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The unambiguous Base32 alphabet the CLI mints login codes from.
 * 23456789ABCDEFGHJKLMNPQRSTUVWXYZ (no 0, 1, I, O).
 */
export const CLI_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
export const CLI_CODE_LENGTH = 8;

export type CliLoginAction = "approve" | "deny";
export type CliLoginErrorCode = "unknown_code" | "expired" | "already_used" | "device_cap";

export interface CliCodeValidation {
  valid: boolean;
  hasInvalidChars: boolean;
  isRightLength: boolean;
}

/** Strip spaces and hyphens, and convert to uppercase. */
export function cleanCliCode(input: string): string {
  return input.replace(/[\s-]+/gu, "").toUpperCase();
}

/** Validate code against the terminal alphabet and required length live. */
export function validateCliCode(code: string): CliCodeValidation {
  const hasInvalidChars = !/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]*$/u.test(code);
  const isRightLength = code.length === CLI_CODE_LENGTH;
  return {
    valid: isRightLength && !hasInvalidChars,
    hasInvalidChars,
    isRightLength,
  };
}

export interface CliLoginOutcome {
  ok: boolean;
  error?: CliLoginErrorCode | "unavailable";
  deviceLabel?: string | null;
}

export function parseCliLoginResponse(data: unknown, error: unknown): CliLoginOutcome {
  let deviceLabel: string | null = null;

  const inspectObject = (obj: unknown) => {
    if (obj && typeof obj === "object" && !Array.isArray(obj)) {
      const record = obj as Record<string, unknown>;
      if (typeof record.device_label === "string" && record.device_label) {
        deviceLabel = record.device_label;
      } else if (typeof record.label === "string" && record.label) {
        deviceLabel = record.label;
      } else if (typeof record.device === "string" && record.device) {
        deviceLabel = record.device;
      }
    }
  };

  inspectObject(data);

  const findErrorCode = (val: unknown): CliLoginErrorCode | null => {
    if (typeof val === "string") {
      if (val === "unknown_code" || val.includes("unknown_code")) return "unknown_code";
      if (val === "expired" || val.includes("expired")) return "expired";
      if (val === "already_used" || val.includes("already_used")) return "already_used";
      if (val === "device_cap" || val.includes("device_cap")) return "device_cap";
    }
    if (val && typeof val === "object") {
      const rec = val as Record<string, unknown>;
      const direct = rec.error ?? rec.code ?? rec.error_code ?? rec.kind;
      const found = findErrorCode(direct);
      if (found) return found;
      if (rec.error && typeof rec.error === "object") {
        return findErrorCode(rec.error);
      }
    }
    return null;
  };

  const dataError = findErrorCode(data);
  if (dataError) {
    return { ok: false, error: dataError, deviceLabel };
  }

  if (error) {
    inspectObject(error);
    const context = (error as Record<string, unknown>).context;
    if (context) inspectObject(context);
    const errCode = findErrorCode(error) ?? findErrorCode(context);
    if (errCode) {
      return { ok: false, error: errCode, deviceLabel };
    }
    const status = Number((context as Record<string, unknown>)?.status);
    if (status === 404) return { ok: false, error: "unknown_code", deviceLabel };
    if (status === 410) return { ok: false, error: "expired", deviceLabel };
    if (status === 409) return { ok: false, error: "already_used", deviceLabel };
    return { ok: false, error: "unavailable", deviceLabel };
  }

  if (data && typeof data === "object") {
    const rec = data as Record<string, unknown>;
    if (rec.ok === false) {
      return { ok: false, error: "unavailable", deviceLabel };
    }
  }

  return { ok: true, deviceLabel };
}

/**
 * Make a request to the cli-login edge function.
 * Transports the signed-in user's JWT via Supabase client functions invoke.
 */
export async function callCliLogin(
  client: SupabaseClient,
  action: CliLoginAction,
  userCode: string,
): Promise<CliLoginOutcome> {
  try {
    const response = await client.functions.invoke("cli-login", {
      body: {
        action,
        user_code: userCode,
      },
    });
    return parseCliLoginResponse(response.data, response.error);
  } catch {
    return { ok: false, error: "unavailable" };
  }
}
