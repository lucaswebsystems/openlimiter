"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session, SupabaseClient } from "@supabase/supabase-js";
import { PageShell, ShellSections } from "@/components/page-shell";
import { Chip } from "@/components/ui";
import { FOUNDER_USER_ID, SUPABASE_ANON_KEY, SUPABASE_URL } from "@/lib/pro";

/**
 * The founder console, rendered only when lib/pro.ts says the rails are on.
 *
 * supabase-js is loaded with a dynamic import inside this client component,
 * so it lives in its own async chunk that only ever downloads when this shell
 * actually mounts. No other route on the site grows by a byte, and with the
 * flag off this shell never mounts at all.
 *
 * Honesty rule for everything on this screen: the console reads through the
 * public anon key under row level security. It sees exactly what the signed
 * in user is allowed to see. Entitlements are readable only by their owning
 * user and stripe_events only by the service role, so panels state what the
 * database actually returned rather than pretending at a wider view.
 */

interface EntitlementRow {
  user_id: string;
  product: string;
  status: string;
  source: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  founding: boolean;
  updated_at: string;
}

interface StripeEventRow {
  id: string;
  type: string;
  received_at: string;
}

type AuthPhase = "booting" | "signedOut" | "linkSent" | "signedIn";

const PANEL = "rounded-xl border border-hairline bg-surface p-6";
const BUTTON_PRIMARY =
  "lift-sm focus-ring inline-flex items-center justify-center gap-2 rounded-lg border border-transparent bg-solid px-4 py-2 text-sm font-medium text-on-solid hover:bg-solid-hover disabled:opacity-50";
const BUTTON_GHOST =
  "lift-sm focus-ring inline-flex items-center justify-center gap-2 rounded-lg border border-hairline-strong bg-transparent px-4 py-2 text-sm font-medium text-heading hover:border-heading hover:bg-surface disabled:opacity-50";
const INPUT =
  "focus-ring w-full rounded-lg border border-hairline bg-canvas px-3 py-2 text-sm text-heading placeholder:text-muted";
const MONO_CELL = "max-w-[16rem] truncate font-mono text-2xs text-soft";

function statusTone(status: string): "accent" | "neutral" | "strong" {
  if (status === "active") return "accent";
  if (status === "comped") return "strong";
  return "neutral";
}

export function AdminShell() {
  const [client, setClient] = useState<SupabaseClient | null>(null);
  const [phase, setPhase] = useState<AuthPhase>("booting");
  const [session, setSession] = useState<Session | null>(null);

  const [email, setEmail] = useState("");
  const [authMessage, setAuthMessage] = useState<string | null>(null);

  const [rows, setRows] = useState<EntitlementRow[]>([]);
  const [rowsError, setRowsError] = useState<string | null>(null);
  const [events, setEvents] = useState<StripeEventRow[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [toggleMessage, setToggleMessage] = useState<string | null>(null);

  /* Boot: load supabase-js in its own chunk, then track the session. */
  useEffect(() => {
    let cancelled = false;
    let unsubscribe: (() => void) | undefined;

    void (async () => {
      const { createClient } = await import("@supabase/supabase-js");
      if (cancelled) return;

      const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
      setClient(supabase);

      const { data } = await supabase.auth.getSession();
      if (cancelled) return;
      setSession(data.session);
      setPhase(data.session === null ? "signedOut" : "signedIn");

      const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
        setSession(nextSession);
        setPhase(nextSession === null ? "signedOut" : "signedIn");
      });
      unsubscribe = () => listener.subscription.unsubscribe();
    })();

    return () => {
      cancelled = true;
      if (unsubscribe !== undefined) unsubscribe();
    };
  }, []);

  const isFounder =
    session !== null && FOUNDER_USER_ID.length > 0 && session.user.id === FOUNDER_USER_ID;

  const loadData = useCallback(async () => {
    if (client === null) return;

    const entitlements = await client
      .from("entitlements")
      .select(
        "user_id, product, status, source, stripe_customer_id, stripe_subscription_id, founding, updated_at",
      )
      .order("updated_at", { ascending: false });
    if (entitlements.error) {
      setRowsError(entitlements.error.message);
      setRows([]);
    } else {
      setRowsError(null);
      setRows((entitlements.data ?? []) as EntitlementRow[]);
    }

    const ledger = await client
      .from("stripe_events")
      .select("id, type, received_at")
      .order("received_at", { ascending: false })
      .limit(20);
    if (ledger.error) {
      setEventsError(ledger.error.message);
      setEvents([]);
    } else {
      setEventsError(null);
      setEvents((ledger.data ?? []) as StripeEventRow[]);
    }
  }, [client]);

  useEffect(() => {
    if (phase === "signedIn" && isFounder) {
      void loadData();
    }
  }, [phase, isFounder, loadData]);

  async function sendMagicLink(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    if (client === null || email.length === 0) return;
    setAuthMessage(null);

    const { error } = await client.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: `${window.location.origin}/admin` },
    });
    if (error) {
      setAuthMessage(`The sign in request failed: ${error.message}`);
      return;
    }
    setPhase("linkSent");
  }

  async function signOut() {
    if (client === null) return;
    await client.auth.signOut();
    setRows([]);
    setEvents([]);
    setToggleMessage(null);
  }

  async function toggleEntitlement(row: EntitlementRow) {
    if (client === null) return;
    setToggleMessage(null);

    const nextStatus = row.status === "active" ? "canceled" : "active";
    const { data, error } = await client
      .from("entitlements")
      .update({ status: nextStatus })
      .eq("user_id", row.user_id)
      .eq("product", row.product)
      .select("user_id");

    if (error) {
      setToggleMessage(`The database refused the write: ${error.message}`);
      return;
    }
    if ((data ?? []).length === 0) {
      setToggleMessage(
        "The database changed 0 rows. Row level security does not let a browser session write entitlements; writes go through the service role webhook in the private repo.",
      );
      return;
    }
    setToggleMessage(`Entitlement for ${row.user_id} set to ${nextStatus}.`);
    await loadData();
  }

  if (phase === "booting") {
    return (
      <PageShell title="Admin" lead="Starting the console.">
        {null}
      </PageShell>
    );
  }

  if (phase === "signedOut" || phase === "linkSent") {
    return (
      <PageShell title="Admin" lead="Founder sign in, by email magic link.">
        <div className={`${PANEL} max-w-md`}>
          {phase === "linkSent" ? (
            <p className="text-sm leading-relaxed text-muted">
              The link is on its way to {email}. Open it on this device and this page will sign
              itself in.
            </p>
          ) : (
            <form onSubmit={sendMagicLink} className="space-y-4">
              <label className="block text-sm font-medium text-heading" htmlFor="admin-email">
                Email
              </label>
              <input
                id="admin-email"
                type="email"
                required
                value={email}
                onChange={(changeEvent) => setEmail(changeEvent.target.value)}
                placeholder="you@example.com"
                className={INPUT}
              />
              <button type="submit" className={BUTTON_PRIMARY} disabled={client === null}>
                Send magic link
              </button>
              {authMessage !== null && (
                <p className="text-sm leading-relaxed text-muted">{authMessage}</p>
              )}
            </form>
          )}
        </div>
      </PageShell>
    );
  }

  if (!isFounder) {
    return (
      <PageShell title="Admin" lead="This console opens only for the founder account.">
        <div className={`${PANEL} max-w-md space-y-4`}>
          <p className="text-sm leading-relaxed text-muted">
            {FOUNDER_USER_ID.length === 0
              ? "No founder user id is configured in this build, so the console stays locked for every account."
              : "The signed in account is not the configured founder account."}
          </p>
          <button type="button" className={BUTTON_GHOST} onClick={() => void signOut()}>
            Sign out
          </button>
        </div>
      </PageShell>
    );
  }

  return (
    <PageShell
      title="Admin"
      lead="Subscribers, entitlements and webhook health, read through row level security."
    >
      <ShellSections>
        <section>
          <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
            <h2 className="text-2xl font-medium text-heading">Subscribers</h2>
            <div className="flex gap-3">
              <button type="button" className={BUTTON_GHOST} onClick={() => void loadData()}>
                Refresh
              </button>
              <button type="button" className={BUTTON_GHOST} onClick={() => void signOut()}>
                Sign out
              </button>
            </div>
          </div>

          <p className="mb-6 max-w-2xl text-sm leading-relaxed text-muted">
            This list holds exactly the entitlement rows the signed in user may read under row
            level security, which today means the owning user&apos;s own rows. A wider founder view
            needs a read policy or a service role endpoint in the private repo, and neither ships
            in this build.
          </p>

          {rowsError !== null && (
            <p className="mb-4 text-sm leading-relaxed text-muted">
              The subscriber query failed: {rowsError}
            </p>
          )}

          {rows.length === 0 && rowsError === null ? (
            <div className={PANEL}>
              <p className="text-sm leading-relaxed text-muted">
                0 entitlement rows are visible to this session.
              </p>
            </div>
          ) : (
            <div className={`${PANEL} overflow-x-auto p-0`}>
              <table className="w-full min-w-[52rem] text-left text-sm">
                <thead>
                  <tr className="border-b border-hairline text-xs uppercase tracking-wider text-muted">
                    <th className="px-4 py-3 font-medium">User</th>
                    <th className="px-4 py-3 font-medium">Status</th>
                    <th className="px-4 py-3 font-medium">Source</th>
                    <th className="px-4 py-3 font-medium">Stripe customer</th>
                    <th className="px-4 py-3 font-medium">Subscription</th>
                    <th className="px-4 py-3 font-medium">Updated</th>
                    <th className="px-4 py-3 font-medium">Toggle</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.user_id}:${row.product}`} className="border-b border-hairline">
                      <td className={`px-4 py-3 ${MONO_CELL}`}>{row.user_id}</td>
                      <td className="px-4 py-3">
                        <span className="inline-flex items-center gap-2">
                          <Chip tone={statusTone(row.status)} dot>
                            {row.status}
                          </Chip>
                          {row.founding && <Chip tone="strong">founding</Chip>}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-muted">{row.source}</td>
                      <td className={`px-4 py-3 ${MONO_CELL}`}>{row.stripe_customer_id ?? "none"}</td>
                      <td className={`px-4 py-3 ${MONO_CELL}`}>
                        {row.stripe_subscription_id ?? "none"}
                      </td>
                      <td className="px-4 py-3 text-muted">
                        {new Date(row.updated_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <button
                          type="button"
                          className={BUTTON_GHOST}
                          onClick={() => void toggleEntitlement(row)}
                        >
                          {row.status === "active" ? "Set canceled" : "Set active"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {toggleMessage !== null && (
            <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">{toggleMessage}</p>
          )}
        </section>

        <section>
          <h2 className="mb-6 text-2xl font-medium text-heading">Webhook health</h2>

          {eventsError !== null && (
            <p className="mb-4 text-sm leading-relaxed text-muted">
              The ledger query failed: {eventsError}
            </p>
          )}

          {events.length === 0 ? (
            <div className={PANEL}>
              <p className="max-w-2xl text-sm leading-relaxed text-muted">
                0 events are visible to this session. The stripe_events ledger allows service role
                reads only, so the browser sees an empty list even while the webhook is healthy.
                Delivery results live in the Stripe dashboard and in the edge function logs.
              </p>
            </div>
          ) : (
            <div className={`${PANEL} p-0`}>
              <ul className="divide-y divide-hairline">
                {events.map((entry) => (
                  <li key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                    <span className="font-mono text-2xs text-soft">{entry.id}</span>
                    <Chip tone="neutral">{entry.type}</Chip>
                    <span className="text-xs text-muted">
                      {new Date(entry.received_at).toLocaleString()}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </ShellSections>
    </PageShell>
  );
}
