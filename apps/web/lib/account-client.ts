import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/pro";

/**
 * The account client, and the one choice a reader makes about how long it
 * lasts.
 *
 * WHY THIS IS NOT A FLAG ON A LIVE CLIENT
 * ---------------------------------------
 * "Keep me signed in" is not a feature of the auth service. A session lives
 * wherever the client was told to put it, and the client is told once, when it
 * is constructed: the storage it writes the refresh token into cannot be
 * changed afterwards. So the switch is read before the client exists, the
 * client is built around the answer, and flipping the switch builds a new one.
 * On means this browser's local storage, which survives the window closing.
 * Off means session storage, which does not: close the tab and the session is
 * gone, which is exactly what somebody on a shared machine is asking for.
 *
 * The preference itself is a boolean, and it lives in local storage in both
 * states, because a reader who turned the switch off still expects it to be
 * off next time. It is not a credential and it names no account.
 *
 * REPLACING A CLIENT IS A HANDOVER, NOT A CONSTRUCTION
 * ----------------------------------------------------
 * Two clients built against the same project both refresh the same refresh
 * token on a timer, and a refresh token is single use: the second one to fire
 * presents a token the first already spent, the service rejects it, and the
 * reader is signed out by a switch that promised the opposite. So the old
 * client's refresh ticker is stopped before anything moves, and the caller
 * drops its auth listener at the same time. `stopAccountClient` and
 * `resumeAccountClient` are that pair, and the second exists because a move
 * that fails has to leave the old client exactly as it was found.
 *
 * WHY THE ADAPTER RESOLVES LATE
 * -----------------------------
 * Every method below asks for its store at the moment it is called rather than
 * holding one. The dashboard builds its client while rendering, which happens
 * on the server as well as in the browser, and a module that reaches for
 * `window` at construction would take the whole route down. Reaching for it
 * inside a call cannot: on a server there is no call.
 */

/** Where the answer to the switch is kept. Not a credential, not an account. */
export const KEEP_SIGNED_IN_KEY = "openlimiter-keep-signed-in";

/** What the switch reads as before anybody has touched it. */
export const KEEP_SIGNED_IN_DEFAULT = true;

/** The shape the auth client asks of a place to keep a session. */
export interface SessionStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

/** A store the move can walk, which the browser's two both are. */
export interface EnumerableStore extends SessionStore {
  readonly length: number;
  key: (index: number) => string | null;
}

function localStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    /* A browser with storage refused decides nothing here. */
    return null;
  }
}

function sessionStore(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    /* Same answer, same reason. */
    return null;
  }
}

/**
 * The name this deployment's auth client keeps its session under.
 *
 * It is the formula the client itself uses, spelled out here rather than
 * guessed at, and then handed back to the client as its `storageKey` so the
 * two can never be different things.
 */
export function authStorageKey(url: string = SUPABASE_URL): string | null {
  if (url === "") return null;
  try {
    const host = new URL(url).hostname;
    const reference = host.split(".")[0] ?? "";
    return reference === "" ? null : `sb-${reference}-auth-token`;
  } catch {
    return null;
  }
}

/**
 * Everything one session occupies, named by the one prefix it all hangs off.
 *
 * The session itself sits under the key above, and the auth library parks
 * whatever else a flow needs beside it under that same key plus a suffix: the
 * code verifier during an exchange, and the flow state a provider round trip
 * leaves behind. Naming two of those and moving only those would strand the
 * third, so the rule is the prefix and nothing but the prefix.
 *
 * The prefix ends in the project reference, which is what keeps this honest in
 * the other direction: another Supabase project on the same origin has a
 * different reference, so none of its keys can begin with ours and none of
 * them is ever carried away. Signing another product's reader out is exactly
 * what a looser match on `sb-` would do.
 */
export function authStoragePrefix(url: string = SUPABASE_URL): string | null {
  return authStorageKey(url);
}

/** Every key in a store that belongs to this project's session. */
export function sessionKeysIn(store: EnumerableStore | null, prefix: string | null): string[] {
  if (store === null || prefix === null || prefix === "") return [];
  const keys: string[] = [];
  try {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && key.startsWith(prefix)) keys.push(key);
    }
  } catch {
    return [];
  }
  return keys;
}

/**
 * The reader's answer, or the default.
 *
 * Only the exact string a write produces counts as off. Anything else, an
 * absent key, a value left by an older build, a store that threw, reads as the
 * default, so the failure mode of this function is the friendly one.
 */
export function readKeepSignedIn(store: SessionStore | null = localStore()): boolean {
  if (store === null) return KEEP_SIGNED_IN_DEFAULT;
  try {
    const raw = store.getItem(KEEP_SIGNED_IN_KEY);
    if (raw === null) return KEEP_SIGNED_IN_DEFAULT;
    return raw !== "false";
  } catch {
    return KEEP_SIGNED_IN_DEFAULT;
  }
}

/** Record the answer, so the next visit opens the switch where it was left. */
export function writeKeepSignedIn(
  value: boolean,
  store: SessionStore | null = localStore(),
): void {
  if (store === null) return;
  try {
    store.setItem(KEEP_SIGNED_IN_KEY, value ? "true" : "false");
  } catch {
    /* The choice still applies to this client, which was already built. */
  }
}

/** Whether the move happened. A refusal is a state the card has a sentence for. */
export type MoveOutcome = { ok: true; moved: number } | { ok: false };

/**
 * Carry a live session across when the switch moves, or carry nothing.
 *
 * Four phases, and the order is the whole safety of it: find every key of ours
 * in the source and remember what the target already held under those names,
 * write them across and read each one back to prove it landed, then remove
 * them from the source. Any refusal, or a write that reads back as something
 * else, undoes everything: the target is put back to exactly what it held,
 * including values that were already there, and the source is left whole. The
 * worst case is a switch that did not move rather than a session that exists
 * in neither place, and the caller keeps its old client and its old answer
 * when this says no.
 */
export function moveAuthSession(
  from: EnumerableStore | null,
  to: SessionStore | null,
  prefix: string | null,
): MoveOutcome {
  if (from === null || to === null || from === to || prefix === null || prefix === "") {
    return { ok: true, moved: 0 };
  }

  const keys = sessionKeysIn(from, prefix);
  if (keys.length === 0) return { ok: true, moved: 0 };

  const carried: [string, string][] = [];
  /* What the target already held under these names. A store is allowed to be
     holding an older session of ours, and losing it on a failed move would be
     this function destroying the very thing it exists to protect. */
  const displaced = new Map<string, string | null>();

  const restoreTarget = (): void => {
    for (const [key, value] of displaced) {
      try {
        if (value === null) to.removeItem(key);
        else to.setItem(key, value);
      } catch {
        /* Both stores are refusing; the caller keeps its old client. */
      }
    }
  };

  try {
    for (const key of keys) {
      const value = from.getItem(key);
      if (value === null) continue;
      carried.push([key, value]);
      displaced.set(key, to.getItem(key));
    }
    for (const [key, value] of carried) {
      to.setItem(key, value);
      if (to.getItem(key) !== value) throw new Error("write not readable");
    }
  } catch {
    restoreTarget();
    return { ok: false };
  }

  try {
    for (const [key] of carried) from.removeItem(key);
  } catch {
    /* A source that will not let go would leave the session readable in a
       store the reader asked to be free of it, so the move is undone whole. */
    for (const [key, value] of carried) {
      try {
        from.setItem(key, value);
      } catch {
        /* Nothing more can be done for a store refusing in both directions. */
      }
    }
    restoreTarget();
    return { ok: false };
  }

  return { ok: true, moved: carried.length };
}

/** Move a session between the two stores this browser has, either direction. */
export function applyKeepSignedIn(keep: boolean): boolean {
  const local = localStore();
  const session = sessionStore();
  const prefix = authStoragePrefix();
  const outcome = keep
    ? moveAuthSession(session, local, prefix)
    : moveAuthSession(local, session, prefix);
  return outcome.ok;
}

/**
 * Stop a client from refreshing before another one is built around the same
 * session. Its own errors are its own: a client that will not stop is still a
 * client the caller is about to abandon, and throwing here would leave the
 * switch stuck.
 */
export async function stopAccountClient(client: SupabaseClient | null): Promise<void> {
  if (client === null) return;
  try {
    await client.auth.stopAutoRefresh();
  } catch {
    /* Nothing further to do; the caller decides what happens next. */
  }
}

/** Put a client back the way it was, for a move that did not happen. */
export async function resumeAccountClient(client: SupabaseClient | null): Promise<void> {
  if (client === null) return;
  try {
    await client.auth.startAutoRefresh();
  } catch {
    /* The session still refreshes on its own next visit. */
  }
}

/**
 * The store the client writes into, resolved at the moment it is asked.
 *
 * A store that is missing answers as an empty one rather than throwing, so a
 * browser with storage switched off signs in for as long as the tab lives and
 * never crashes the route on the way.
 */
export function sessionStorageAdapter(keep: boolean): SessionStore {
  const pick = (): Storage | null => (keep ? localStore() : sessionStore());
  return {
    getItem: (key) => {
      try {
        return pick()?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    setItem: (key, value) => {
      try {
        pick()?.setItem(key, value);
      } catch {
        /* The session stays in memory for this page. */
      }
    },
    removeItem: (key) => {
      try {
        pick()?.removeItem(key);
      } catch {
        /* Nothing to remove from a store that will not answer. */
      }
    },
  };
}

/**
 * One account client, built around the answer to the switch.
 *
 * It is the same client the hub reads synced usage with, so there is one
 * session on this surface rather than one per concern. The storage key is
 * passed rather than left to the default, and it is the value the default
 * would have produced, so no existing session is orphaned and the move above
 * has an exact prefix to work with. A deployment with no hosted address builds
 * nothing and says so by returning null, which is the state the sign in card
 * already draws.
 */
export function createAccountClient(keep: boolean): SupabaseClient | null {
  if (SUPABASE_URL === "" || SUPABASE_ANON_KEY === "") return null;
  const storageKey = authStorageKey();
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
      storage: sessionStorageAdapter(keep),
      ...(storageKey === null ? {} : { storageKey }),
    },
  });
}
