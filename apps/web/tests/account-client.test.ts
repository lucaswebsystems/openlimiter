import { describe, expect, it } from "vitest";
import {
  KEEP_SIGNED_IN_DEFAULT,
  KEEP_SIGNED_IN_KEY,
  authStorageKey,
  authStoragePrefix,
  moveAuthSession,
  readKeepSignedIn,
  resumeAccountClient,
  sessionStorageAdapter,
  stopAccountClient,
  writeKeepSignedIn,
} from "@/lib/account-client";

/**
 * How long a session lasts, which is decided before the client exists.
 *
 * The rule these tests hold is that the switch can never lose a session. On
 * means local storage, off means session storage, and moving between them
 * carries whatever was already signed in rather than stranding it in a store
 * nothing reads.
 */

/** A store with the two extras `moveAuthSession` walks, and nothing else. */
function fakeStore(entries: Record<string, string> = {}) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() {
      return map.size;
    },
    key: (index: number) => [...map.keys()][index] ?? null,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
    removeItem: (key: string) => {
      map.delete(key);
    },
  };
}

describe("the keep me signed in answer", () => {
  it("is on before anybody has touched it", () => {
    expect(KEEP_SIGNED_IN_DEFAULT).toBe(true);
    expect(readKeepSignedIn(fakeStore())).toBe(true);
    expect(readKeepSignedIn(null)).toBe(true);
  });

  it("reads only an explicit off as off", () => {
    expect(readKeepSignedIn(fakeStore({ [KEEP_SIGNED_IN_KEY]: "false" }))).toBe(false);
    expect(readKeepSignedIn(fakeStore({ [KEEP_SIGNED_IN_KEY]: "true" }))).toBe(true);
    /* Anything a newer or older build could have left behind is not an off. */
    expect(readKeepSignedIn(fakeStore({ [KEEP_SIGNED_IN_KEY]: "0" }))).toBe(true);
  });

  it("writes an answer the next visit can read back", () => {
    const store = fakeStore();
    writeKeepSignedIn(false, store);
    expect(store.map.get(KEEP_SIGNED_IN_KEY)).toBe("false");
    expect(readKeepSignedIn(store)).toBe(false);
    writeKeepSignedIn(true, store);
    expect(readKeepSignedIn(store)).toBe(true);
  });

  it("survives a store that refuses to answer at all", () => {
    const refuses = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => undefined,
    };
    expect(readKeepSignedIn(refuses)).toBe(true);
    expect(() => writeKeepSignedIn(false, refuses)).not.toThrow();
  });
});

describe("the name one session hangs off", () => {
  it("is the key the auth client itself would have chosen", () => {
    expect(authStorageKey("https://abcdefgh.supabase.co")).toBe("sb-abcdefgh-auth-token");
    expect(authStoragePrefix("https://abcdefgh.supabase.co")).toBe("sb-abcdefgh-auth-token");
  });

  it("is nothing at all when there is no hosted address to derive it from", () => {
    expect(authStorageKey("")).toBeNull();
    expect(authStorageKey("not a url")).toBeNull();
    expect(authStoragePrefix("")).toBeNull();
  });
});

describe("moving a live session between the two stores", () => {
  const PREFIX = "sb-project-auth-token";

  it("carries every key that hangs off this project's prefix, and nothing else", () => {
    const from = fakeStore({
      "sb-project-auth-token": "session",
      "sb-project-auth-token-code-verifier": "verifier",
      /* Whatever else the auth library parks beside the session, under a name
         this file does not have to know in advance. */
      "sb-project-auth-token.0": "flow state",
      "sb-someone-else-auth-token": "another product",
      "openlimiter-app-live": "readings",
    });
    const to = fakeStore();

    expect(moveAuthSession(from, to, PREFIX)).toEqual({ ok: true, moved: 3 });
    expect(to.map.get("sb-project-auth-token")).toBe("session");
    expect(to.map.get("sb-project-auth-token-code-verifier")).toBe("verifier");
    expect(to.map.get("sb-project-auth-token.0")).toBe("flow state");
    expect(from.map.has("sb-project-auth-token.0")).toBe(false);

    /* Another Supabase project on this origin is somebody else's product, and
       carrying its session away would sign their reader out. */
    expect(from.map.get("sb-someone-else-auth-token")).toBe("another product");
    expect(to.map.has("sb-someone-else-auth-token")).toBe(false);
    expect(from.map.get("openlimiter-app-live")).toBe("readings");
  });

  it("aborts with both stores untouched when the target refuses the write", () => {
    const from = fakeStore({ "sb-project-auth-token": "session" });
    const to = {
      ...fakeStore(),
      setItem: () => {
        throw new Error("quota");
      },
    };

    expect(moveAuthSession(from, to, PREFIX)).toEqual({ ok: false });
    /* The one thing that must never happen: a session in neither store. */
    expect(from.getItem("sb-project-auth-token")).toBe("session");
  });

  it("aborts when the target accepts a write and hands back something else", () => {
    const from = fakeStore({ "sb-project-auth-token": "session" });
    const to = { ...fakeStore(), getItem: () => null, setItem: () => undefined };

    expect(moveAuthSession(from, to, PREFIX)).toEqual({ ok: false });
    expect(from.getItem("sb-project-auth-token")).toBe("session");
  });

  it("puts back what the target already held when the move fails", () => {
    const from = fakeStore({
      "sb-project-auth-token": "new session",
      "sb-project-auth-token-code-verifier": "verifier",
    });
    const inner = fakeStore({ "sb-project-auth-token": "older session" });
    const to = {
      ...inner,
      getItem: (key: string) => inner.getItem(key),
      /* The first key lands, the second is refused, so the rollback has to
         undo a write that already overwrote something. */
      setItem: (key: string, value: string) => {
        if (key.endsWith("-code-verifier")) throw new Error("quota");
        inner.setItem(key, value);
      },
      removeItem: (key: string) => inner.removeItem(key),
    };

    expect(moveAuthSession(from, to, PREFIX)).toEqual({ ok: false });
    expect(inner.map.get("sb-project-auth-token")).toBe("older session");
    expect(from.map.get("sb-project-auth-token")).toBe("new session");
  });

  it("undoes the whole move when the source will not let go", () => {
    const inner = fakeStore({ "sb-project-auth-token": "session" });
    const from = {
      ...inner,
      getItem: (key: string) => inner.getItem(key),
      setItem: (key: string, value: string) => inner.setItem(key, value),
      removeItem: () => {
        throw new Error("locked");
      },
    };
    const to = fakeStore();

    expect(moveAuthSession(from, to, PREFIX)).toEqual({ ok: false });
    /* Never left readable in the store the reader asked to be free of. */
    expect(to.map.has("sb-project-auth-token")).toBe(false);
    expect(inner.map.get("sb-project-auth-token")).toBe("session");
  });

  it("moves nothing when there is nowhere to move it", () => {
    expect(moveAuthSession(null, fakeStore(), PREFIX)).toEqual({ ok: true, moved: 0 });
    expect(moveAuthSession(fakeStore({ "sb-project-auth-token": "x" }), null, PREFIX)).toEqual({
      ok: true,
      moved: 0,
    });
    expect(moveAuthSession(fakeStore(), fakeStore(), null)).toEqual({ ok: true, moved: 0 });
  });
});

describe("handing one client over to the next", () => {
  it("stops the old client's refresh ticker and can put it back", async () => {
    const calls: string[] = [];
    const client = {
      auth: {
        stopAutoRefresh: async () => {
          calls.push("stop");
        },
        startAutoRefresh: async () => {
          calls.push("start");
        },
      },
    } as unknown as Parameters<typeof stopAccountClient>[0];

    await stopAccountClient(client);
    await resumeAccountClient(client);
    expect(calls).toEqual(["stop", "start"]);
  });

  it("never throws on a client that refuses, or on no client at all", async () => {
    const angry = {
      auth: {
        stopAutoRefresh: async () => {
          throw new Error("no");
        },
        startAutoRefresh: async () => {
          throw new Error("no");
        },
      },
    } as unknown as Parameters<typeof stopAccountClient>[0];

    await expect(stopAccountClient(angry)).resolves.toBeUndefined();
    await expect(resumeAccountClient(angry)).resolves.toBeUndefined();
    await expect(stopAccountClient(null)).resolves.toBeUndefined();
    await expect(resumeAccountClient(null)).resolves.toBeUndefined();
  });
});

describe("the storage the client is built around", () => {
  it("writes into local storage when the switch is on", () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const adapter = sessionStorageAdapter(true);
    adapter.setItem("sb-project-auth-token", "session");
    expect(window.localStorage.getItem("sb-project-auth-token")).toBe("session");
    expect(window.sessionStorage.getItem("sb-project-auth-token")).toBeNull();
    expect(adapter.getItem("sb-project-auth-token")).toBe("session");
    adapter.removeItem("sb-project-auth-token");
    expect(adapter.getItem("sb-project-auth-token")).toBeNull();
  });

  it("writes into session storage when the switch is off", () => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    const adapter = sessionStorageAdapter(false);
    adapter.setItem("sb-project-auth-token", "session");
    expect(window.sessionStorage.getItem("sb-project-auth-token")).toBe("session");
    expect(window.localStorage.getItem("sb-project-auth-token")).toBeNull();
  });
});
