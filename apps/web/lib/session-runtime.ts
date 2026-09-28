import type { AuthChangeEvent, Session, SupabaseClient } from "@supabase/supabase-js";
import { applyKeepSignedIn, clearPrivateSessionState, createAccountClient, readKeepSignedIn, resumeAccountClient, stopAccountClient, writeKeepSignedIn } from "./account-client";
import { endPhoneSession, readCurrentPhoneBars, type PhoneReadOutcome } from "./phone-session";
import { listCloudKeys, type CloudMeterKey } from "./cloud-meter";
import { clearIntent, pendingIntent } from "./pending-intent";
import { readProAccount, type ProEntitlement } from "./pro";
import { readSyncedApiSpend, readSyncedUsage, type SyncedApiSpend, type SyncedUsageResult } from "./synced-usage";
import { parseQuotaText, type Snapshot } from "../app/app/engine";

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

export interface AccountSessionState {
  client: SupabaseClient | null;
  session: Session | null | undefined;
  keepSignedIn: boolean;
  syncEnabled: boolean;
  live: readonly Snapshot[];
  syncedUsage: SyncedUsageResult | null;
  syncedSpend: SyncedApiSpend[];
  cloudRows: CloudMeterKey[];
  spendFailed: boolean;
  cloudFailed: boolean;
  entitlement: ProEntitlement | null | undefined;
}

export interface AccountSessionRuntime extends SessionRuntime<AccountSessionState> {
  current(): AccountSessionState;
  refreshEntitlement(): Promise<void>;
  acceptEntitlement(userId: string | undefined, entitlement: ProEntitlement | null): void;
  changeKeepSignedIn(next: boolean): Promise<boolean>;
  setSyncEnabled(next: boolean): void;
  logout(): Promise<void>;
}

const LIVE_KEY = "openlimiter-app-live";
const WEB_SYNC_KEY = "openlimiter-web-sync-enabled";
function readLiveSnapshots(): Snapshot[] {
  try {
    const raw = window.localStorage.getItem(LIVE_KEY);
    if (!raw || !Array.isArray(JSON.parse(raw))) return [];
    const result = parseQuotaText(raw, new Date().toISOString());
    return result.ok ? [...result.snapshots] : [];
  } catch { return []; }
}

/** The freeze boundary: identity, clients, private results and storage move together. */
export function createAccountSessionRuntime(): AccountSessionRuntime {
  let state: AccountSessionState = {
    client: null, session: undefined, keepSignedIn: readKeepSignedIn(), syncEnabled: true,
    live: [], syncedUsage: null, syncedSpend: [], cloudRows: [],
    spendFailed: false, cloudFailed: false, entitlement: undefined,
  };
  let active = false;
  let generation = 0;
  let authRevision = 0;
  let entitlementRevision = 0;
  let subscription: { unsubscribe(): void } | undefined;
  let poll: SessionRuntime<void> | undefined;
  let flight: Promise<void> | undefined;
  let handover: Promise<boolean> | undefined;
  let locallySignedOut = false;
  const listeners = new Set<(value: AccountSessionState) => void>();
  const publish = (patch: Partial<AccountSessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener(state);
  };
  const invalidate = () => {
    generation += 1;
    entitlementRevision += 1;
    flight = undefined;
    poll?.stop();
    poll = undefined;
  };
  const clearResults = () => publish({
    syncedUsage: null, syncedSpend: [], cloudRows: [], spendFailed: false,
    cloudFailed: false, entitlement: undefined,
  });
  const read = (): Promise<void> => {
    if (!active) return Promise.resolve();
    if (!state.syncEnabled) {
      publish({ syncedUsage: { ok: false, reason: "signed_out" } });
      return Promise.resolve();
    }
    if (flight) return flight;
    const turn = generation;
    const client = state.client;
    const request = Promise.allSettled([
      readSyncedUsage(client), readSyncedApiSpend(client),
      client === null ? Promise.resolve(null) : listCloudKeys(client),
    ]).then(([usage, spend, cloud]) => {
      if (!active || turn !== generation) return;
      publish({
        syncedUsage: usage.status === "fulfilled" ? usage.value : { ok: false, reason: "unavailable" },
        ...(spend.status === "fulfilled" && spend.value.ok
          ? { syncedSpend: spend.value.sources, spendFailed: false } : { spendFailed: true }),
        ...(cloud.status === "fulfilled" && cloud.value?.ok
          ? { cloudRows: cloud.value.value, cloudFailed: false } : { cloudFailed: true }),
      });
    }).finally(() => { if (flight === request) flight = undefined; });
    flight = request;
    return request;
  };
  const refreshEntitlement = async () => {
    const turn = generation;
    const revision = ++entitlementRevision;
    const client = state.client;
    if (!active) return;
    if (client === null) { publish({ entitlement: null }); return; }
    try {
      const result = await readProAccount(client);
      if (active && turn === generation && revision === entitlementRevision) {
        publish({ entitlement: result.ok ? result.value.entitlement : undefined });
      }
    } catch {
      if (active && turn === generation && revision === entitlementRevision) publish({ entitlement: undefined });
    }
  };
  const startPoll = () => {
    if (!active || !state.syncEnabled || !state.session || poll) return;
    poll = createSessionRuntime({ read });
    poll.start();
  };
  const attach = () => {
    const revision = ++authRevision;
    const client = state.client;
    if (!client) { publish({ session: null }); void read(); return; }
    subscription = observeAccountSession(client, (event, next) => {
      if (!active || revision !== authRevision) return;
      if (locallySignedOut && event !== "SIGNED_IN") return;
      if (event === "SIGNED_IN") locallySignedOut = false;
      const previous = state.session?.user.id ?? null;
      const identity = next?.user.id ?? null;
      if (previous !== identity || event === "SIGNED_OUT") {
        invalidate();
        clearResults();
      }
      if (event === "SIGNED_OUT" || (previous !== null && previous !== identity)) {
        clearIntent();
        publish({ live: [] });
      } else if (next) pendingIntent(next.user.id);
      publish({ session: next });
      startPoll();
      // Supabase awaits auth callbacks under its lock. Reads must start afterwards.
      const turn = generation;
      window.setTimeout(() => {
        if (!active || revision !== authRevision || turn !== generation) return;
        if (next) void refreshEntitlement();
      }, 0);
    });
  };
  const changeKeepSignedIn = (next: boolean): Promise<boolean> => {
    if (handover) return handover;
    if (next === state.keepSignedIn) return Promise.resolve(true);
    const request = (async () => {
      invalidate();
      const client = state.client;
      const turn = generation;
      await stopAccountClient(client);
      if (!active || turn !== generation) {
        if (active && client === state.client) await resumeAccountClient(client);
        return false;
      }
      subscription?.unsubscribe();
      subscription = undefined;
      authRevision += 1;
      if (!applyKeepSignedIn(next)) {
        await resumeAccountClient(client);
        if (active && turn === generation) { attach(); startPoll(); }
        return false;
      }
      writeKeepSignedIn(next);
      clearResults();
      publish({ keepSignedIn: next, client: createAccountClient(next) });
      attach();
      startPoll();
      return true;
    })().finally(() => { if (handover === request) handover = undefined; });
    handover = request;
    return request;
  };
  return {
    start() {
      if (active) return;
      active = true;
      try {
        const store = window.localStorage;
        const legacy = store.getItem("openlimiter-app-snapshots");
        if (legacy !== null && store.getItem("openlimiter-app-sample") !== "1" && store.getItem(LIVE_KEY) === null) {
          store.setItem(LIVE_KEY, legacy);
        }
        store.removeItem("openlimiter-app-snapshots");
        store.removeItem("openlimiter-app-sample");
        state = { ...state, syncEnabled: store.getItem(WEB_SYNC_KEY) !== "false" };
      } catch { /* Storage is optional. */ }
      if (state.client) void resumeAccountClient(state.client);
      publish({ client: state.client ?? createAccountClient(state.keepSignedIn), live: readLiveSnapshots() });
      if (document.visibilityState !== "hidden") void read();
      attach();
    },
    stop() {
      active = false;
      invalidate();
      authRevision += 1;
      subscription?.unsubscribe();
      subscription = undefined;
      void stopAccountClient(state.client);
    },
    current: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    refresh() { publish({ live: readLiveSnapshots() }); return read(); },
    refreshEntitlement,
    acceptEntitlement(userId, entitlement) {
      if (active && userId && userId === state.session?.user.id) publish({ entitlement });
    },
    changeKeepSignedIn,
    setSyncEnabled(next) {
      invalidate();
      clearResults();
      try { window.localStorage.setItem(WEB_SYNC_KEY, String(next)); } catch { /* Keep the choice in memory. */ }
      publish({ syncEnabled: next });
      startPoll();
      if (!next) void read();
      void refreshEntitlement();
    },
    async logout() {
      locallySignedOut = true;
      invalidate();
      clearPrivateSessionState();
      clearIntent();
      clearResults();
      publish({ session: null, live: [] });
      await state.client?.auth.signOut();
    },
  };
}
