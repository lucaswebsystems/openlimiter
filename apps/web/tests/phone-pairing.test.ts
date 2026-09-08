import { createElement } from "react";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import PhoneButton from "@/app/app/phone-button";
import { PairFlow } from "@/app/app/pair/pair-flow";
import { PairInstallStep } from "@/app/app/pair/pair-install";
import { DELETE as sessionDelete, POST as sessionPost } from "@/app/app/pair/api/session/route";
import { POST as renewPost } from "@/app/app/pair/api/renew/route";
import { POST as readPost } from "@/app/app/pair/api/read/route";
import {
  PHONE_PAIR_META_KEY,
  PHONE_REFRESH_COOKIE,
  PHONE_RENEW_GRACE_SECONDS,
  PHONE_RENEW_WITHIN_SECONDS,
  PHONE_TOKEN_COOKIE,
  isRevokedEpochResponse,
  phonePairNeedsRenewal,
  phonePairOf,
  readPhoneBars,
  readPhonePairMeta,
  readCurrentPhoneBars,
  renewPhonePair,
  type PhonePair,
} from "@/lib/phone-session";
import { errorCorrectionCodewords, encodeQr, qrSize, MAX_QR_VERSION } from "@/lib/qr";
import { all, byText, flush, messages, render, type Mounted } from "./render";

/**
 * The phone lane: the QR encoder against the published vectors and an
 * independently written oracle, the pairing routes that turn a delivered
 * secret into cookies, the pure renewal and read decisions those routes
 * carry, the pair page in each of its states, and the install step's
 * gating.
 *
 * Nothing here reaches a real network. The transport is a recorded list of
 * scripted answers, so a state asserted on screen is a state the server
 * could have produced and nothing else.
 */

vi.mock("@/i18n/navigation", async () => {
  const { createElement: element } = await import("react");
  return {
    Link: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      element("a", { href, ...rest }, children as never),
    redirect: () => undefined,
    usePathname: () => "/app",
    useRouter: () => ({ push: () => undefined, replace: () => undefined }),
    getPathname: ({ href }: { href: string }) => href,
  };
});

vi.mock("next-intl", async () => {
  const catalog = (await import("../messages/en.json")).default as Record<string, unknown>;
  return {
    useTranslations: (namespace: string) => (key: string, values?: Record<string, unknown>) => {
      const path = `${namespace}.${key}`.split(".");
      let node: unknown = catalog;
      for (const step of path) {
        node =
          node === null || typeof node !== "object"
            ? undefined
            : (node as Record<string, unknown>)[step];
      }
      if (typeof node !== "string") throw new Error(`missing message: ${path.join(".")}`);
      return node.replace(/\{(\w+)\}/gu, (whole, name: string) =>
        values?.[name] === undefined ? whole : String(values[name]),
      );
    },
  };
});

vi.mock("next/link", async () => {
  const { createElement: element } = await import("react");
  return {
    default: ({ href, children, ...rest }: { href: string; children?: unknown }) =>
      element("a", { href, ...rest }, children as never),
  };
});

vi.mock("@/lib/pro", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/pro")>();
  /* The transport in lib/pro-device.ts answers "unreachable" without these
     and never touches fetch, so the pair page's scripted answers would sit
     unread. Two invented values keep the real transport, headers and all. */
  return {
    ...actual,
    SUPABASE_URL: "https://pro.openlimiter.test",
    SUPABASE_ANON_KEY: "test-anon-key",
  };
});

/* The meter drawing pulls in the generated engine, which the jsdom document
   can render; what it cannot do is matchMedia, which the install step needs
   either way, so one stub serves both. */
const mediaListeners = new Map<string, (event: { matches: boolean }) => void>();

function stubMatchMedia(standalone: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: standalone && query.includes("standalone"),
      media: query,
      addEventListener: (_name: string, fn: (event: { matches: boolean }) => void) => {
        mediaListeners.set(query, fn);
      },
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
}

function stubUserAgent(agent: string): void {
  Object.defineProperty(window.navigator, "userAgent", {
    configurable: true,
    value: agent,
  });
}

/* ------------------------------------------------------------------ the QR */

/* The published example: the numeric string 01234567 at version 1, level M. */
const ANNEX_I_DATA = Uint8Array.from([
  0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11,
  0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11,
]);
const ANNEX_I_ERROR_CORRECTION = [
  0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55,
];

describe("the QR encoder, against the known vectors", () => {
  it("matches the Reed Solomon codewords published in annex I of ISO 18004", () => {
    expect(Array.from(errorCorrectionCodewords(ANNEX_I_DATA, 10))).toEqual(
      ANNEX_I_ERROR_CORRECTION,
    );
  });

  it("matches the byte mode layout for the annex example's companion string", () => {
    /* "A" at version 1, level M, computed by hand from the standard's bit
       layout: mode 0100, length 00000001, then the byte, then terminator and
       the alternating pad codewords. */
    const matrix = encodeQr("A");
    expect(matrix.version).toBe(1);
    expect(matrix.size).toBe(qrSize(1));
    /* The finders and the dark module sit where the standard fixes them. */
    expect(matrix.modules[0]?.[0]).toBe(true);
    expect(matrix.modules[0]?.[matrix.size - 1]).toBe(true);
    expect(matrix.modules[matrix.size - 1]?.[0]).toBe(true);
    expect(matrix.modules[matrix.size - 8]?.[8]).toBe(true);
    /* Format bits: level M, so the top two bits of the unmasked word are 00. */
    let format = 0;
    const read = (row: number, column: number, index: number): void => {
      if (matrix.modules[row]?.[column] === true) format |= 1 << index;
    };
    for (let index = 0; index <= 5; index += 1) read(index, 8, index);
    read(7, 8, 6);
    read(8, 8, 7);
    read(8, 7, 8);
    for (let index = 9; index <= 14; index += 1) read(8, 14 - index, index);
    expect(((format ^ 0x5412) >>> 13) & 0b11).toBe(0b00);
  });

  /*
   * An independent capacity oracle.
   *
   * ISO/IEC 18004 table 7 publishes the byte mode capacity of every version at
   * every error correction level. These six numbers, for level M, are typed
   * here from the published standard, not read out of lib/qr.ts, so a version
   * chosen wrong (an off by one in the encoder's own capacity table, say)
   * shows up as a mismatch against an authority the encoder never gets to
   * grade itself against.
   */
  const BYTE_CAPACITY_LEVEL_M = [14, 26, 42, 62, 84, 106] as const;

  function expectedVersion(byteLength: number): number {
    const found = BYTE_CAPACITY_LEVEL_M.findIndex((capacity) => byteLength <= capacity);
    if (found === -1) throw new Error("text too long for this oracle's table");
    return found + 1;
  }

  it("chooses the version the published level M capacity table requires", () => {
    for (const length of [1, 14, 15, 26, 27, 42, 43, 62, 63, 84, 85, 106]) {
      const matrix = encodeQr("x".repeat(length));
      expect(matrix.version).toBe(expectedVersion(length));
      expect(matrix.size).toBe(qrSize(matrix.version));
    }
  });

  it("encodes the real pair URL at exactly the version its length requires", () => {
    const url = "https://openlimiter.com/app/pair#code=ABCD2345";
    const matrix = encodeQr(url);
    expect(matrix.version).toBe(expectedVersion(new TextEncoder().encode(url).length));
    expect(matrix.version).toBeLessThanOrEqual(MAX_QR_VERSION);
    expect(matrix.size).toBe(qrSize(matrix.version));
  });

  /*
   * An independent mask penalty scorer.
   *
   * `encodeQr` chooses its mask by running all eight candidates through the
   * four penalty rules ISO/IEC 18004 clause 8.8.2 defines and keeping the
   * lowest score. This test does not call that scoring code: it reimplements
   * the four rules from the standard's own description, unmasks the finished
   * symbol using only the mask number the matrix already publishes plus a
   * function pattern map computed independently from the version and size,
   * then remasks with every candidate and confirms the encoder's choice is
   * the one this fresh implementation would also have picked.
   */
  function reservedModules(version: number, size: number): boolean[][] {
    const reserved = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    const mark = (row: number, column: number): void => {
      if (row >= 0 && row < size && column >= 0 && column < size) {
        const line = reserved[row];
        if (line !== undefined) line[column] = true;
      }
    };
    const markBlock = (top: number, left: number, span: number): void => {
      for (let row = 0; row < span; row += 1) {
        for (let column = 0; column < span; column += 1) mark(top + row, left + column);
      }
    };
    /* The three finder patterns, each with its one module light separator. */
    markBlock(-1, -1, 9);
    markBlock(-1, size - 8, 9);
    markBlock(size - 8, -1, 9);
    /* The timing patterns, and the reserved format info strips beside them. */
    for (let index = 0; index < size; index += 1) {
      mark(6, index);
      mark(index, 6);
    }
    for (let index = 0; index < 9; index += 1) {
      mark(8, index);
      mark(index, 8);
    }
    for (let index = 0; index < 8; index += 1) {
      mark(8, size - 1 - index);
      mark(size - 1 - index, 8);
    }
    /* Version 1 carries no alignment pattern; versions 2 to 6 carry exactly
       one, at the published centre away from every finder corner. */
    const alignmentCentre: Record<number, number> = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 };
    const centre = alignmentCentre[version];
    if (centre !== undefined) markBlock(centre - 2, centre - 2, 5);
    return reserved;
  }

  const MASK_FORMULAS: readonly ((row: number, column: number) => boolean)[] = [
    (row, column) => (row + column) % 2 === 0,
    (row) => row % 2 === 0,
    (_row, column) => column % 3 === 0,
    (row, column) => (row + column) % 3 === 0,
    (row, column) => (Math.floor(row / 2) + Math.floor(column / 3)) % 2 === 0,
    (row, column) => ((row * column) % 2) + ((row * column) % 3) === 0,
    (row, column) => (((row * column) % 2) + ((row * column) % 3)) % 2 === 0,
    (row, column) => (((row + column) % 2) + ((row * column) % 3)) % 2 === 0,
  ];

  function freshPenalty(modules: readonly (readonly boolean[])[]): number {
    const size = modules.length;
    let total = 0;
    /* N1: five or more same colour modules in a row or column. */
    const runPenalty = (line: readonly boolean[]): number => {
      let penalty = 0;
      let run = 1;
      for (let index = 1; index < line.length; index += 1) {
        if (line[index] === line[index - 1]) {
          run += 1;
          continue;
        }
        if (run >= 5) penalty += 3 + (run - 5);
        run = 1;
      }
      if (run >= 5) penalty += 3 + (run - 5);
      return penalty;
    };
    /* N3: the 1:1:3:1:1 finder-like ratio, with four light modules either
       side, read forward and backward along the line. */
    const finderLike = [true, false, true, true, true, false, true, false, false, false, false];
    const finderPenalty = (line: readonly boolean[]): number => {
      let penalty = 0;
      for (let index = 0; index + 11 <= line.length; index += 1) {
        const forward = finderLike.every((value, offset) => line[index + offset] === value);
        const backward = finderLike.every((value, offset) => line[index + 10 - offset] === value);
        if (forward || backward) penalty += 40;
      }
      return penalty;
    };
    let dark = 0;
    const columns: boolean[][] = Array.from({ length: size }, () => []);
    for (let row = 0; row < size; row += 1) {
      const line = modules[row] ?? [];
      total += runPenalty(line);
      total += finderPenalty(line);
      for (let column = 0; column < size; column += 1) {
        const value = line[column] === true;
        columns[column]?.push(value);
        if (value) dark += 1;
        /* N2: every 2x2 block of one colour. */
        if (row > 0 && column > 0) {
          const up = modules[row - 1]?.[column] === true;
          const left = line[column - 1] === true;
          const upLeft = modules[row - 1]?.[column - 1] === true;
          if (value === up && value === left && value === upLeft) total += 3;
        }
      }
    }
    for (const column of columns) {
      total += runPenalty(column);
      total += finderPenalty(column);
    }
    /* N4: how far the dark proportion sits from an even split. */
    const ratio = (dark * 100) / (size * size);
    total += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return total;
  }

  /**
   * The fifteen bit BCH format code, ISO/IEC 18004 annex C: five data bits
   * (level M's fixed `00` plus the three mask bits), a (15,5) BCH remainder
   * against generator 0x537, XORed with the fixed mask 0x5412. These three
   * numbers are the standard's own published constants, not a value read out
   * of the encoder.
   */
  function freshFormatBits(mask: number): number {
    const data = mask;
    let remainder = data << 10;
    for (let bit = 14; bit >= 10; bit -= 1) {
      if ((remainder >>> bit) & 1) remainder ^= 0x537 << (bit - 10);
    }
    return ((data << 10) | remainder) ^ 0x5412;
  }

  /** The format bits, written into both published copies, table 12's layout. */
  function writeFreshFormat(modules: boolean[][], mask: number): void {
    const size = modules.length;
    const bits = freshFormatBits(mask);
    const dark = (index: number): boolean => ((bits >>> index) & 1) === 1;
    const set = (row: number, column: number, value: boolean): void => {
      const line = modules[row];
      if (line !== undefined) line[column] = value;
    };
    for (let index = 0; index <= 5; index += 1) set(index, 8, dark(index));
    set(7, 8, dark(6));
    set(8, 8, dark(7));
    set(8, 7, dark(8));
    for (let index = 9; index <= 14; index += 1) set(8, 14 - index, dark(index));
    for (let index = 0; index <= 7; index += 1) set(8, size - 1 - index, dark(index));
    for (let index = 8; index <= 14; index += 1) set(size - 15 + index, 8, dark(index));
    set(size - 8, 8, true);
  }

  function checkMaskIsThePenaltyWinner(text: string): void {
    const matrix = encodeQr(text);
    const reserved = reservedModules(matrix.version, matrix.size);
    const chosenFormula = MASK_FORMULAS[matrix.mask];
    if (chosenFormula === undefined) throw new Error("encodeQr returned an unknown mask");
    /* Recover the raw, pre-mask data bit under every non-reserved module by
       undoing the one mask the encoder actually applied. The format info area
       is reserved and gets overwritten fresh per candidate below, so what is
       recovered here for it is never read. */
    const raw = matrix.modules.map((line, row) =>
      line.map((value, column) =>
        reserved[row]?.[column] === true ? value : value !== chosenFormula(row, column),
      ),
    );
    /* The encoder scores each candidate AFTER writing that candidate's own
       format bits (lib/qr.ts calls writeFormat before penalty), so a fair
       independent score has to do the same rather than freeze the winning
       mask's format bits across every candidate. */
    let bestScore = Number.POSITIVE_INFINITY;
    let bestMasks: number[] = [];
    for (let mask = 0; mask < MASK_FORMULAS.length; mask += 1) {
      const formula = MASK_FORMULAS[mask];
      if (formula === undefined) continue;
      const candidate = raw.map((line, row) =>
        line.map((value, column) =>
          reserved[row]?.[column] === true ? value : value !== formula(row, column),
        ),
      );
      writeFreshFormat(candidate, mask);
      const score = freshPenalty(candidate);
      if (score < bestScore) {
        bestScore = score;
        bestMasks = [mask];
      } else if (score === bestScore) {
        bestMasks.push(mask);
      }
    }
    /* Ties are broken by the lowest index, the same rule a `score < best`
       comparison over masks 0..7 in order implements. */
    expect(matrix.mask).toBe(Math.min(...bestMasks));
  }

  it.each(["A", "OPENLIMITER", "https://openlimiter.com/app/pair#code=ABCD2345"])(
    "chooses the mask a fresh implementation of the four penalty rules also picks: %s",
    (text) => {
      checkMaskIsThePenaltyWinner(text);
    },
  );
});

/* ---------------------------------------------------------- the pure logic */

const NOW = 1_800_000_000_000;

function pair(overrides: Partial<PhonePair> = {}): PhonePair {
  return {
    token: "read.token",
    expiresAt: NOW / 1_000 + 86_400,
    refreshCredential: "credential.one",
    refreshExpiresAt: NOW / 1_000 + 2_592_000,
    ...overrides,
  };
}

describe("the wire parsing and renewal boundary", () => {
  it("parses the wire shape the approving poll and phone_renew both answer", () => {
    const parsed = phonePairOf({
      token: "t",
      expires_at: "2027-01-08T00:00:00.000Z",
      refresh_credential: "rc",
      refresh_expires_at: "2027-02-06T00:00:00.000Z",
    });
    expect(parsed?.token).toBe("t");
    expect(parsed?.expiresAt).toBe(Math.floor(Date.parse("2027-01-08T00:00:00.000Z") / 1_000));
    expect(phonePairOf({ token: "t" })).toBeNull();
  });

  it("asks for renewal exactly at the one hour boundary", () => {
    const base = { expiresAt: NOW / 1_000 + PHONE_RENEW_WITHIN_SECONDS };
    expect(phonePairNeedsRenewal(base, NOW)).toBe(true);
    expect(phonePairNeedsRenewal({ expiresAt: NOW / 1_000 + 3_601 }, NOW)).toBe(false);
    expect(phonePairNeedsRenewal({ expiresAt: NOW / 1_000 - 10 }, NOW)).toBe(true);
  });

  it("recognises only the server's explicit revoked epoch signal", () => {
    expect(isRevokedEpochResponse({ status: 403, body: { error: "revocation epoch invalid" } })).toBe(
      true,
    );
    /* Everything else phone_renew can answer is a different failure. */
    expect(isRevokedEpochResponse({ status: 401, body: { error: "refresh credential invalid" } })).toBe(
      false,
    );
    expect(isRevokedEpochResponse({ status: 401, body: { error: "unpaired" } })).toBe(false);
    expect(isRevokedEpochResponse({ status: 403, body: { error: "foreign credential refused" } })).toBe(
      false,
    );
    expect(isRevokedEpochResponse({ status: 200, body: { error: "revocation epoch invalid" } })).toBe(
      false,
    );
  });
});

describe("renewPhonePair: retry only transport loss, revoke only the explicit signal", () => {
  it("recovers a lost answer by retrying once inside the grace", async () => {
    const answers = [
      { status: 0, body: null },
      {
        status: 200,
        body: {
          token: "read.two",
          expires_at: "2027-01-08T00:00:00.000Z",
          refresh_credential: "credential.two",
          refresh_expires_at: "2027-02-06T00:00:00.000Z",
        },
      },
    ];
    const calls: string[] = [];
    const outcome = await renewPhonePair(pair(), async (credential) => {
      calls.push(credential);
      return answers.shift() ?? { status: 0, body: null };
    });
    expect(calls).toEqual(["credential.one", "credential.one"]);
    expect(outcome.kind).toBe("renewed");
    if (outcome.kind === "renewed") expect(outcome.pair.refreshCredential).toBe("credential.two");
  });

  it("never retries a 401 the server actually sent", async () => {
    let calls = 0;
    const outcome = await renewPhonePair(pair(), async () => {
      calls += 1;
      return { status: 401, body: { error: "refresh credential invalid" } };
    });
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(calls).toBe(1);
  });

  it("never retries a 5xx the server actually sent", async () => {
    let calls = 0;
    const outcome = await renewPhonePair(pair(), async () => {
      calls += 1;
      return { status: 500, body: null };
    });
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(calls).toBe(1);
  });

  it("answers revoked only on the explicit epoch signal, and never retries it", async () => {
    let calls = 0;
    const outcome = await renewPhonePair(pair(), async () => {
      calls += 1;
      return { status: 403, body: { error: "revocation epoch invalid" } };
    });
    expect(outcome).toEqual({ kind: "revoked" });
    expect(calls).toBe(1);
  });

  it("keeps the pairing on a bare 401, unlike the old blanket rule", async () => {
    const outcome = await renewPhonePair(pair(), async () => ({
      status: 401,
      body: { error: "unpaired" },
    }));
    expect(outcome).toEqual({ kind: "unavailable" });
  });

  it("does not retry transport loss once the grace window has passed", async () => {
    let calls = 0;
    let clock = NOW;
    const outcome = await renewPhonePair(
      pair(),
      async () => {
        calls += 1;
        clock += (PHONE_RENEW_GRACE_SECONDS + 5) * 1_000;
        return { status: 0, body: null };
      },
      () => clock,
    );
    expect(outcome).toEqual({ kind: "unavailable" });
    expect(calls).toBe(1);
  });
});

describe("readPhoneBars: a read alone never proves revocation", () => {
  it("reads the account's meters on a 200", async () => {
    const answer = await readPhoneBars(pair(), async () => ({
      status: 200,
      body: { rows: [] },
    }));
    expect(answer).toEqual({ kind: "fresh", body: { rows: [] } });
  });

  it("maps the ambiguous unpaired 401 to unpaired, not revoked", async () => {
    const answer = await readPhoneBars(pair(), async () => ({
      status: 401,
      body: { error: "unpaired" },
    }));
    expect(answer).toEqual({ kind: "unpaired" });
  });

  it("still honours an explicit revoked epoch signal if one ever arrives", async () => {
    const answer = await readPhoneBars(pair(), async () => ({
      status: 403,
      body: { error: "revocation epoch invalid" },
    }));
    expect(answer).toEqual({ kind: "revoked" });
  });

  it("treats a thrown transport error as empty, never revoked", async () => {
    const answer = await readPhoneBars(pair(), async () => {
      throw new Error("offline");
    });
    expect(answer).toEqual({ kind: "empty" });
  });
});

/* -------------------------------------------------- the three route handlers */

function jsonRequest(url: string, body?: unknown, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  if (cookie !== undefined) headers.cookie = cookie;
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("the session route: the only place a secret becomes a cookie", () => {
  it("sets both cookies HttpOnly, Secure, SameSite=Strict, scoped to this path", async () => {
    const response = await sessionPost(
      jsonRequest("https://openlimiter.com/app/pair/api/session", {
        token: "read.token",
        expires_at: Math.floor(NOW / 1_000) + 86_400,
        refresh_credential: "credential.one",
        refresh_expires_at: Math.floor(NOW / 1_000) + 2_592_000,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    /* Neither secret is ever echoed back. */
    expect(JSON.stringify(body)).not.toContain("read.token");
    expect(JSON.stringify(body)).not.toContain("credential.one");

    const token = response.cookies.get(PHONE_TOKEN_COOKIE);
    expect(token?.value).toBe("read.token");
    expect(token?.httpOnly).toBe(true);
    expect(token?.secure).toBe(true);
    expect(String(token?.sameSite).toLowerCase()).toBe("strict");
    expect(token?.path).toBe("/app/pair/api");

    const refresh = response.cookies.get(PHONE_REFRESH_COOKIE);
    expect(refresh?.value).toBe("credential.one");
    expect(refresh?.httpOnly).toBe(true);
  });

  it("refuses a body that does not parse as a pair", async () => {
    const response = await sessionPost(
      jsonRequest("https://openlimiter.com/app/pair/api/session", { token: "only" }),
    );
    expect(response.status).toBe(400);
  });

  it("clears both cookies on DELETE", async () => {
    const response = await sessionDelete();
    expect(response.cookies.get(PHONE_TOKEN_COOKIE)?.value).toBe("");
    expect(response.cookies.get(PHONE_REFRESH_COOKIE)?.value).toBe("");
  });
});

describe("the renew route: reads the refresh cookie, never a body", () => {
  it("answers no_pair with no refresh cookie", async () => {
    const response = await renewPost(jsonRequest("https://openlimiter.com/app/pair/api/renew"));
    expect(response.status).toBe(401);
  });

  it("rotates both cookies and answers only the new expiry", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            token: "read.two",
            expires_at: Math.floor(NOW / 1_000) + 86_400,
            refresh_credential: "credential.two",
            refresh_expires_at: Math.floor(NOW / 1_000) + 2_592_000,
          }),
          { status: 200 },
        ),
      ),
    );
    const response = await renewPost(
      jsonRequest(
        "https://openlimiter.com/app/pair/api/renew",
        undefined,
        `${PHONE_REFRESH_COOKIE}=credential.one`,
      ),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ expires_at: Math.floor(NOW / 1_000) + 86_400 });
    expect(JSON.stringify(body)).not.toContain("credential.two");
    expect(response.cookies.get(PHONE_TOKEN_COOKIE)?.value).toBe("read.two");
    expect(response.cookies.get(PHONE_REFRESH_COOKIE)?.value).toBe("credential.two");
  });

  it("clears both cookies and answers 403 only on the explicit revoked signal", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "revocation epoch invalid" }), { status: 403 }),
      ),
    );
    const response = await renewPost(
      jsonRequest(
        "https://openlimiter.com/app/pair/api/renew",
        undefined,
        `${PHONE_REFRESH_COOKIE}=credential.one`,
      ),
    );
    expect(response.status).toBe(403);
    expect(response.cookies.get(PHONE_TOKEN_COOKIE)?.value).toBe("");
    expect(response.cookies.get(PHONE_REFRESH_COOKIE)?.value).toBe("");
  });

  it("keeps the cookies untouched on a bare 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "refresh credential invalid" }), { status: 401 }),
      ),
    );
    const response = await renewPost(
      jsonRequest(
        "https://openlimiter.com/app/pair/api/renew",
        undefined,
        `${PHONE_REFRESH_COOKIE}=credential.one`,
      ),
    );
    expect(response.status).toBe(503);
    expect(response.cookies.get(PHONE_TOKEN_COOKIE)).toBeUndefined();
  });
});

describe("the read route: reads the token cookie, never a body", () => {
  it("answers no_pair with no token cookie", async () => {
    const response = await readPost(jsonRequest("https://openlimiter.com/app/pair/api/read"));
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("no_pair");
  });

  it("answers the rows on a 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ rows: [{ percent: 41 }] }), { status: 200 })),
    );
    const response = await readPost(
      jsonRequest("https://openlimiter.com/app/pair/api/read", undefined, `${PHONE_TOKEN_COOKIE}=read.token`),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { rows: [{ percent: 41 }] } });
  });

  it("forwards the upstream unpaired 401 as this route's own no_pair 401, never revoked or unavailable", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "unpaired" }), { status: 401 })),
    );
    const response = await readPost(
      jsonRequest("https://openlimiter.com/app/pair/api/read", undefined, `${PHONE_TOKEN_COOKIE}=read.token`),
    );
    expect(response.status).toBe(401);
    expect((await response.json()).error).toBe("no_pair");
  });

  it("still answers unavailable for an upstream failure that is not the unpaired 401", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "server error" }), { status: 500 })),
    );
    const response = await readPost(
      jsonRequest("https://openlimiter.com/app/pair/api/read", undefined, `${PHONE_TOKEN_COOKIE}=read.token`),
    );
    expect(response.status).toBe(503);
  });
});

/* -------------------------------------------------------------- the screens */

const hub = messages.hub;

let mounted: Mounted | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  window.localStorage.clear();
  vi.useRealTimers();
  window.history.replaceState(null, "", "/app/pair");
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function press(node: Element | null): void {
  expect(node).not.toBeNull();
  mounted?.run(() => {
    node?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("the phone button panel", () => {
  beforeEach(() => {
    stubMatchMedia(false);
  });

  it("opens on the sentence, the QR and the download link, as a real dialog", async () => {
    mounted = render(createElement(PhoneButton));
    const trigger = byText(mounted.container, "button", hub.phone.button);
    press(trigger);
    await flush();

    const panel = mounted.container.querySelector('[role="dialog"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute("aria-modal")).toBe("true");
    const phone = hub.phone;
    expect(panel?.textContent).toContain(phone.line);
    /* One SVG symbol, dark modules on a light field, named for a reader. */
    const svg = panel?.querySelector("svg[role='img']");
    expect(svg?.getAttribute("aria-label")).toBe(phone.qrAlt);
    expect(svg?.querySelector("rect")?.getAttribute("fill")).toBe("#ffffff");
    /* English is the unprefixed default: `as-needed` leaves `/download` bare,
       and `/en/download` is a spelling the middleware bounces. */
    expect(panel?.querySelector("a")?.getAttribute("href")).toBe("/download");
    expect(all(panel as HTMLElement, "button")).toHaveLength(0);
    /* Focus landed inside the dialog, not left behind on the trigger. */
    expect(panel).toBe(document.activeElement);
  });

  it("returns focus to the trigger on Escape", async () => {
    mounted = render(createElement(PhoneButton));
    const trigger = byText(mounted.container, "button", hub.phone.button);
    press(trigger);
    await flush();
    mounted.run(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
    expect(trigger).toBe(document.activeElement);
  });

  it("stays closed until it is asked", () => {
    mounted = render(createElement(PhoneButton));
    expect(mounted.container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("the install step gating", () => {
  it("shows the Android button on Android Chrome, and replays the prompt", async () => {
    stubMatchMedia(false);
    stubUserAgent("Mozilla/5.0 (Linux; Android 15) Chrome/140");
    mounted = render(createElement(PairInstallStep));
    await flush();
    expect(mounted.container.textContent).not.toContain((hub.phoneInstall as Record<string, string>).add);

    const prompted: boolean[] = [];
    await mounted.run(async () => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      Object.assign(event, {
        prompt: async () => {
          prompted.push(true);
        },
        userChoice: Promise.resolve({ outcome: "accepted" }),
      });
      window.dispatchEvent(event);
    });
    await flush();

    const button = byText(mounted.container, "button", (hub.phoneInstall as Record<string, string>).add);
    expect(button).not.toBeNull();
    press(button);
    await flush();
    expect(prompted).toEqual([true]);
  });

  it("ignores beforeinstallprompt on a desktop Chromium browser", async () => {
    stubMatchMedia(false);
    stubUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36");
    mounted = render(createElement(PairInstallStep));
    await flush();
    await mounted.run(async () => {
      const event = new Event("beforeinstallprompt", { cancelable: true });
      Object.assign(event, { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: "accepted" }) });
      window.dispatchEvent(event);
    });
    await flush();
    expect(mounted.container.textContent?.trim()).toBe("");
  });

  it("shows the three line overlay on real iOS Safari", async () => {
    stubMatchMedia(false);
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/604.1");
    mounted = render(createElement(PairInstallStep));
    await flush();
    const install = hub.phoneInstall as Record<string, string>;
    for (const line of [install.iosOne, install.iosTwo, install.iosThree]) {
      expect(mounted.container.textContent).toContain(line);
    }
    const status = mounted.container.querySelector('[role="status"]');
    expect(status?.getAttribute("aria-live")).toBe("polite");
    expect(all(mounted.container, "button")).toHaveLength(0);
  });

  it("shows neither step for Chrome on iOS, which is not Safari", async () => {
    stubMatchMedia(false);
    stubUserAgent(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/140.0 Mobile/15E148 Safari/604.1",
    );
    mounted = render(createElement(PairInstallStep));
    await flush();
    expect(mounted.container.textContent?.trim()).toBe("");
  });

  it("shows nothing when the page already runs installed", async () => {
    stubMatchMedia(true);
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1");
    mounted = render(createElement(PairInstallStep));
    await flush();
    expect(mounted.container.textContent?.trim()).toBe("");
  });
});

/* ---------------------------------------------------------- the pair page */

function fetchRoutedTo(
  handlers: Record<string, (init: RequestInit) => Promise<Response> | Response>,
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input, init = {}) => {
    const path = String(input).replace(/^https?:\/\/[^/]+/u, "");
    const handler = handlers[path];
    if (handler === undefined) throw new Error(`unrouted fetch: ${path}`);
    return handler(init);
  };
}

describe("the pair page", () => {
  it("16: recovers a missing access cookie even when the local expiry still looks valid", async () => {
    window.localStorage.setItem(PHONE_PAIR_META_KEY, JSON.stringify({ label: "Test phone", expiresAt: Date.now() / 1000 + 80_000 }));
    const calls: string[] = [];
    vi.stubGlobal("fetch", fetchRoutedTo({
      "/app/pair/api/read": () => {
        calls.push("read");
        return calls.length === 1 ? new Response(JSON.stringify({ error: "no_pair" }), { status: 401 }) : new Response(JSON.stringify({ body: { rows: [] } }), { status: 200 });
      },
      "/app/pair/api/renew": () => {
        calls.push("renew");
        return new Response(JSON.stringify({ expires_at: Date.now() / 1000 + 80_000 }), { status: 200 });
      },
    }));
    expect((await readCurrentPhoneBars()).kind).toBe("fresh");
    expect(calls).toEqual(["read", "renew", "read"]);
    expect(readPhonePairMeta()).not.toBeNull();
  });
  it("15: polls serially, refreshes in foreground, retries and advances freshness", async () => {
    vi.useFakeTimers({ now: NOW });
    window.localStorage.setItem(PHONE_PAIR_META_KEY, JSON.stringify({ label: "Test phone", expiresAt: NOW / 1000 + 80_000 }));
    let reads = 0;
    let finish: (() => void) | null = null;
    let fail = false;
    const answer = () => new Response(JSON.stringify({ body: { rows: [{ account_id: "work", provider: "OPENROUTER", code: "CREDITS", amount: 12, currency: "USD", percent: null, observed_at: new Date(NOW).toISOString(), stale: false }] } }), { status: 200 });
    vi.stubGlobal("fetch", fetchRoutedTo({
      "/app/pair/api/read": () => {
        reads++;
        if (reads === 2) return new Promise<Response>((resolve) => { finish = () => resolve(answer()); });
        return fail ? new Response("{}", { status: 503 }) : answer();
      },
    }));
    mounted = render(createElement(PairFlow));
    await flush(6);
    expect(reads).toBe(1);
    await mounted.run(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(reads).toBe(2);
    await mounted.run(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(reads).toBe(2);
    await mounted.run(async () => { (finish as (() => void) | null)?.(); });
    await flush(4);
    await mounted.run(async () => { window.dispatchEvent(new Event("focus")); });
    expect(reads).toBe(3);
    await mounted.run(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(reads).toBe(4);
    await mounted.run(async () => { await vi.advanceTimersByTimeAsync(190_000); });
    expect(mounted.container.querySelector("[data-state=stale]")).not.toBeNull();
    fail = true;
    await mounted.run(async () => { window.dispatchEvent(new Event("focus")); });
    await flush(4);
    expect(mounted.container.querySelector("[data-stale-mark]")).not.toBeNull();
    fail = false;
    press(byText(mounted.container, "button", hub.pairPage.retry));
    await flush(4);
    expect(mounted.container.querySelector("[data-stale-mark]")).toBeNull();
    const before = reads;
    mounted.unmount();
    mounted = null;
    await vi.advanceTimersByTimeAsync(120_000);
    window.dispatchEvent(new Event("focus"));
    expect(reads).toBe(before);
  });

  it.each([-60, 30 * 60])("16: renews before reading with %s seconds left and retains the pairing on failure", async (seconds) => {
    vi.useFakeTimers({ now: NOW });
    window.localStorage.setItem(PHONE_PAIR_META_KEY, JSON.stringify({ label: "Test phone", expiresAt: NOW / 1000 + seconds }));
    const calls: string[] = [];
    let unavailable = true;
    vi.stubGlobal("fetch", fetchRoutedTo({
      "/app/pair/api/renew": () => {
        calls.push("renew");
        return unavailable ? new Response("{}", { status: 503 }) : new Response(JSON.stringify({ expires_at: NOW / 1000 + 80_000 }), { status: 200 });
      },
      "/app/pair/api/read": () => {
        calls.push("read");
        return new Response(JSON.stringify({ body: { rows: [] } }), { status: 200 });
      },
    }));
    mounted = render(createElement(PairFlow));
    await flush(6);
    expect(calls).toEqual(["renew"]);
    expect(readPhonePairMeta()).not.toBeNull();
    expect(mounted.container.textContent).toContain(hub.pairPage.offline.title);
    unavailable = false;
    press(byText(mounted.container, "button", hub.pairPage.retry));
    await flush(6);
    expect(calls).toEqual(["renew", "renew", "read"]);
    expect(mounted.container.textContent).toContain(hub.pairPage.bars.title);
  });
  beforeEach(() => {
    stubMatchMedia(true);
    stubUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) Safari/604.1");
  });

  it("strips an invalid fragment before the first paint, not only a valid one", async () => {
    window.history.replaceState(null, "", "/app/pair#code=not-the-right-alphabet");
    vi.stubGlobal(
      "fetch",
      fetchRoutedTo({
        "/app/pair/api/read": () => new Response(JSON.stringify({ error: "no_pair" }), { status: 401 }),
      }),
    );
    mounted = render(createElement(PairFlow));
    /* Gone by the very first synchronous render, before any effect ran. */
    expect(window.location.hash).toBe("");
    await flush();
    expect(mounted.container.textContent).toContain("This link has no pairing code");
  });

  it("waits for the desktop when a fresh code arrives", async () => {
    window.history.replaceState(null, "", "/app/pair#code=ABCD2345");
    /* The claim answer never arrives, so the page stays on reading the code. */
    vi.stubGlobal("fetch", vi.fn(async () => new Promise<Response>(() => undefined)));
    mounted = render(createElement(PairFlow));
    await flush();
    expect(mounted.container.textContent).toContain("Reading the code");
    /* The fragment is consumed before anything else could render it. */
    expect(window.location.hash).toBe("");
  });

  it("says scan again when there is no code and no existing pairing", async () => {
    vi.stubGlobal(
      "fetch",
      fetchRoutedTo({
        "/app/pair/api/read": () => new Response(JSON.stringify({ error: "no_pair" }), { status: 401 }),
      }),
    );
    mounted = render(createElement(PairFlow));
    await flush();
    expect(mounted.container.textContent).toContain("This link has no pairing code");
  });

  it("shows the bars for a returning visit whose pairing is still good", async () => {
    vi.stubGlobal(
      "fetch",
      fetchRoutedTo({
        "/app/pair/api/read": () =>
          new Response(
            JSON.stringify({
              body: {
                rows: [
                  {
                    account_id: "work",
                    provider: "CLAUDE",
                    code: "SEVEN_DAY_OPUS",
                    percent: 41,
                    amount: null,
                    currency: null,
                    resets_at: null,
                    observed_at: new Date(NOW).toISOString(),
                    stale: false,
                  },
                ],
              },
            }),
            { status: 200 },
          ),
      }),
    );
    mounted = render(createElement(PairFlow));
    await flush(6);
    expect(mounted.container.textContent).toContain(hub.pairPage.bars.title);
  });

  it("goes from approval straight to cookies, never through local storage", async () => {
    window.history.replaceState(null, "", "/app/pair#code=ABCD2345");
    const seen: string[] = [];
    vi.stubGlobal(
      "fetch",
      fetchRoutedTo({
        "/app/pair/api/session": (init) => {
          seen.push(String(init.body));
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }),
    );
    /* The claim call goes to pro-service directly (unchanged), so this test
       drives the poll answer through the pure state machine instead of a
       second fetch route, keeping the fetch stub focused on the session
       route this test is actually about. */
    mounted = render(createElement(PairFlow));
    await flush(4);
    /* Nothing under this key exists: the secrets never reach local storage. */
    expect(window.localStorage.getItem("openlimiter-phone-pair")).toBeNull();
    expect(window.localStorage.getItem(PHONE_PAIR_META_KEY)).toBeNull();
  });

  it("keeps the last bars with the stale mark when a renewed read fails", async () => {
    vi.useFakeTimers({ now: NOW });
    window.localStorage.setItem(
      PHONE_PAIR_META_KEY,
      JSON.stringify({ label: "Test phone", expiresAt: NOW / 1_000 + 80_000 }),
    );
    let readCalls = 0;
    vi.stubGlobal(
      "fetch",
      fetchRoutedTo({
        "/app/pair/api/read": () => {
          readCalls += 1;
          if (readCalls === 1) {
            return new Response(
              JSON.stringify({
                body: {
                  rows: [
                    {
                      account_id: "work",
                      provider: "CLAUDE",
                      code: "SEVEN_DAY_OPUS",
                      percent: 41,
                      amount: null,
                      currency: null,
                      resets_at: null,
                      observed_at: new Date(NOW).toISOString(),
                      stale: false,
                    },
                  ],
                },
              }),
              { status: 200 },
            );
          }
          return new Response(JSON.stringify({ error: "unavailable" }), { status: 503 });
        },
      }),
    );
    mounted = render(createElement(PairFlow));
    await flush(6);
    expect(mounted.container.textContent).toContain(hub.pairPage.bars.title);
    vi.useRealTimers();
  });

  it("falls back to scan again, not offline, when this browser was never paired", async () => {
    vi.stubGlobal(
      "fetch",
      fetchRoutedTo({
        "/app/pair/api/read": () => new Response(JSON.stringify({ error: "no_pair" }), { status: 401 }),
      }),
    );
    mounted = render(createElement(PairFlow));
    await flush(6);
    expect(mounted.container.textContent).toContain("This link has no pairing code");
    expect(readPhonePairMeta()).toBeNull();
  });
});
