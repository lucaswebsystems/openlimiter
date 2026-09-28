import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import { clearPrivateSessionState } from "./account-client";
import { endPhoneSession, readCurrentPhoneBars, type PhoneReadOutcome } from "./phone-session";

export const SESSION_POLL_MS = 60_000;

export interface SessionRuntime<T> {
  start(): void;
  stop(): void;
  current(): T | undefined;
  subscribe(listener: (state: T) => void): () => void;
  refresh(): Promise<void>;
}

/** One visible, serial read loop. Stopping invalidates answers already in flight. */
export function createSessionRuntime<T>(options: {
  read: () => Promise<T>;
  terminal?: (state: T) => boolean;
}): SessionRuntime<T> {
  let active = false;
  let generation = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let flight: Promise<void> | undefined;
  let state: T | undefined;
  let wakePending = false;
  const listeners = new Set<(value: T) => void>();
  const visible = () => typeof document === "undefined" || document.visibilityState !== "hidden";
  const cancelTimer = () => { clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    cancelTimer();
    if (active && visible()) timer = setTimeout(() => { void refresh(); }, SESSION_POLL_MS);
  };
  const refresh = (): Promise<void> => {
    if (!active || !visible()) return Promise.resolve();
    if (flight) return flight;
    cancelTimer();
    const turn = generation;
    const request = Promise.resolve().then(options.read).then((next) => {
      if (!active || turn !== generation) return;
      state = next;
      for (const listener of listeners) listener(next);
      if (options.terminal?.(next)) stop();
    }).catch(() => {
      // A transport failure leaves the last reading intact and retries on cadence.
    }).finally(() => {
      if (flight === request) flight = undefined;
      if (active) {
        if (wakePending) { wakePending = false; void refresh(); }
        else schedule();
      }
    });
    flight = request;
    return request;
  };
  const wake = () => {
    cancelTimer();
    if (!visible()) return;
    void refresh();
  };
  function stop() {
    active = false;
    generation += 1;
    wakePending = false;
    cancelTimer();
    document.removeEventListener("visibilitychange", wake);
    window.removeEventListener("online", wake);
    window.removeEventListener("focus", wake);
    window.removeEventListener("storage", wake);
  }
  return {
    start() {
      if (active) return;
      active = true;
      document.addEventListener("visibilitychange", wake);
      window.addEventListener("online", wake);
      window.addEventListener("focus", wake);
      window.addEventListener("storage", wake);
      if (flight) wakePending = true;
      void refresh();
    },
    stop,
    current: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh,
  };
}

export function createPhoneSessionRuntime(): SessionRuntime<PhoneReadOutcome> {
  const runtime = createSessionRuntime({
    read: readCurrentPhoneBars,
    terminal: (answer) => answer.kind === "revoked" || answer.kind === "unpaired",
  });
  runtime.subscribe((answer) => {
    if (answer.kind === "revoked" || answer.kind === "unpaired") void endPhoneSession();
  });
  return runtime;
}

/** Discovery and auth events share one generation so late discovery cannot undo logout. */
export function observeAccountSession(
  client: SupabaseClient,
  listener: (event: AuthChangeEvent, session: Session | null) => void,
): { unsubscribe(): void } {
  let active = true;
  let revision = 0;
  let identity: string | null = null;
  const accept = (event: AuthChangeEvent, session: Session | null) => {
    if (!active) return;
    const next = session?.user.id ?? null;
    if (event === "SIGNED_OUT" || (identity !== null && next !== identity)) {
      clearPrivateSessionState(session);
    }
    identity = next;
    listener(event, session);
  };
  const { data } = client.auth.onAuthStateChange((event, session) => {
    revision += 1;
    accept(event, session);
  });
  const initialRevision = revision;
  void client.auth.getSession().then(({ data }) => {
    if (revision === initialRevision) accept("INITIAL_SESSION", data.session);
  }).catch(() => {
    if (revision === initialRevision) accept("INITIAL_SESSION", null);
  });
  return { unsubscribe() { active = false; data.subscription.unsubscribe(); } };
}
