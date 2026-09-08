"use client";

import type { SupabaseClient } from "@supabase/supabase-js";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import {
  buildOpenRouterAuthorization,
  storeOpenRouterVerifier,
} from "@/lib/openrouter-oauth";
import {
  CLOUD_METER_PROVIDERS,
  deleteCloudKey,
  listCloudKeys,
  pollCloudKeyNow,
  storeCloudKey,
  type CloudMeterFailure,
  type CloudMeterKey,
  type CloudMeterProvider,
} from "@/lib/cloud-meter";
import { Button, DollarRow, Panel, observationAgeMinutes } from "./pieces";
import { ProviderMark } from "./marks";
import { StartTrialButton } from "./trial";

/**
 * "Meter from the cloud", the Pro surface that reads spend with no device
 * running.
 *
 * Everything here is a thin client over `lib/cloud-meter.ts`: this file draws
 * the panel, decides nothing about what a status code means, and never keeps
 * a key. The one rule that matters most is in `CloudKeyForm` below: a typed
 * key exists in this component's state and nowhere the browser persists
 * anything, and the field is cleared the moment the call that sent it
 * finishes, success or not.
 */

const CLOUD_KEY_PROVIDERS: readonly CloudMeterProvider[] = CLOUD_METER_PROVIDERS.filter(
  (provider) => provider !== "openrouter",
);

/** The provider mark this panel already has artwork for. */
const MARK_CODE: Record<CloudMeterProvider, string> = {
  anthropic_admin: "CLAUDE",
  openai_admin: "CODEX",
  xai: "GROK",
  moonshot: "KIMI",
  openrouter: "OPENROUTER",
};

function CloudSpendRow({ row, now, failed, t }: {
  row: CloudMeterKey;
  now: string;
  failed: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const age = observationAgeMinutes(row.observedAt, now);
  const stale = failed || row.lastStatus !== "ok" || row.amount === null || row.currency === null || age === null || age > 5;
  return (
    <DollarRow
      key={row.id}
      icon={<CloudGlyph className="h-3.5 w-3.5" />}
      name={row.observedAt === null ? row.label : `${row.label} (${t("cloud.observed", { time: new Date(row.observedAt).toLocaleString() })})`}
      amountText={
        row.amount !== null && row.currency !== null
          ? formatCloudAmount(row.amount, row.currency)
          : t("cloud.status.pending")
      }
      stale={stale}
      freshLabel={t("cloud.fresh")}
      staleLabel={t("cloud.stale")}
      observationLabel={age === null ? t("cloud.observationUnknown") : t("cloud.observationAge", { minutes: age })}
      stateAnnouncement={t("cloud.stateAnnouncement", { state: stale ? t("cloud.stale") : t("cloud.fresh") })}
    />
  );
}

function CloudGlyph({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M7 18a4.5 4.5 0 0 1-.6-8.96 5.5 5.5 0 0 1 10.7-1.7A4 4 0 0 1 17 18H7Z" />
    </svg>
  );
}

/* ------------------------------------------------------------- one stored row */

/**
 * Which existing sentence a row's last poll status reads with.
 *
 * The hub's own vocabulary carries two states no key in this catalog's
 * `cloud.status` group was ever written for: `rate_limited` and
 * `unauthorized`. Rather than a copy change on the docs lane's side of this
 * release, both reuse a sentence already shipped elsewhere in this same `hub`
 * namespace: the trial wizard's own rate limit line, and the sentence a
 * refused key already carries in this very form. `needs_attention` reads with
 * the same "not answering" sentence `error` does, since both mean the same
 * thing to somebody scanning this list: something here wants a look.
 */
const STATUS_MESSAGE_KEY: Record<CloudMeterKey["lastStatus"], string> = {
  ok: "cloud.status.ok",
  error: "cloud.status.error",
  rate_limited: "trial.error.rateLimited",
  unauthorized: "cloud.form.error",
  needs_attention: "cloud.status.error",
  unknown: "cloud.status.unknown",
};

function StatusChip({ status, t }: { status: CloudMeterKey["lastStatus"]; t: ReturnType<typeof useTranslations> }) {
  return (
    <span className="ol-directory-access" data-access={status === "ok" ? "automatic" : undefined}>
      {t(STATUS_MESSAGE_KEY[status])}
    </span>
  );
}

function CloudKeyRow({
  row,
  onPollNow,
  onDelete,
  t,
}: {
  row: CloudMeterKey;
  onPollNow: (id: string) => Promise<boolean>;
  onDelete: (id: string) => Promise<boolean>;
  t: ReturnType<typeof useTranslations>;
}) {
  const [busy, setBusy] = useState<"poll" | "delete" | null>(null);
  const [error, setError] = useState(false);
  const operate = async (action: "poll" | "delete") => {
    if (busy !== null) return;
    setBusy(action);
    setError(false);
    try {
      setError(!await (action === "poll" ? onPollNow(row.id) : onDelete(row.id)));
    } catch {
      setError(true);
    } finally {
      setBusy(null);
    }
  };
  return (
    <li className="ol-directory-row">
      <div className="ol-directory-identity">
        <span className="ol-provider-mark" data-provider={MARK_CODE[row.provider]}>
          <ProviderMark provider={MARK_CODE[row.provider]} label={row.label} />
        </span>
        <span className="ol-directory-name">
          <strong>{row.label}</strong>
          <span>{t(`cloud.providerNames.${row.provider}`)}</span>
        </span>
      </div>
      <StatusChip status={row.lastStatus} t={t} />
      <div>{error && <p role="alert">{t("cloud.unavailable")}</p>}</div>
      <div className="flex items-center justify-end gap-2">
        <Button
          tone="ghost"
          disabled={busy !== null}
          onClick={() => { void operate("poll"); }}
        >
          {busy === "poll" ? t("cloud.polling") : t("cloud.pollNow")}
        </Button>
        <Button
          tone="ghost"
          disabled={busy !== null}
          onClick={() => { void operate("delete"); }}
        >
          {busy === "delete" ? t("cloud.deleting") : t("cloud.delete")}
        </Button>
      </div>
    </li>
  );
}

/* ------------------------------------------------------------------ the form */

function CloudKeyForm({
  client,
  onAdded,
  t,
}: {
  client: SupabaseClient;
  onAdded: (row: CloudMeterKey) => void;
  t: ReturnType<typeof useTranslations>;
}) {
  const [provider, setProvider] = useState<CloudMeterProvider>(CLOUD_KEY_PROVIDERS[0] ?? "anthropic_admin");
  const [label, setLabel] = useState("");
  /* The one field this whole feature exists to protect. It lives in this
     state and this state only: no draft is ever written to local storage,
     session storage or anywhere else, and it is cleared below on every
     outcome, success included, so a key never sits in memory longer than the
     one request that sends it. */
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<CloudMeterFailure | null>(null);

  const submit = useCallback(() => {
    if (key.trim() === "" || label.trim() === "" || busy) return;
    setBusy(true);
    setError(null);
    void storeCloudKey(client, { provider, label: label.trim(), key: key.trim() }).then((result) => {
      setBusy(false);
      setKey("");
      if (result.ok) {
        setLabel("");
        onAdded(result.value);
        return;
      }
      setError(result.reason);
    });
  }, [busy, client, key, label, onAdded, provider]);

  return (
    <div className="mt-4 space-y-3 border-t border-hairline pt-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-sm text-muted">
          {t("cloud.form.providerLabel")}
          <select
            value={provider}
            onChange={(event) => setProvider(event.target.value as CloudMeterProvider)}
            disabled={busy}
            className="focus-ring rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-heading"
          >
            {CLOUD_KEY_PROVIDERS.map((code) => (
              <option key={code} value={code}>
                {t(`cloud.providerNames.${code}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm text-muted">
          {t("cloud.form.labelLabel")}
          <input
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t("cloud.form.labelPlaceholder")}
            disabled={busy}
            className="focus-ring rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-heading"
          />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-sm text-muted">
        {t("cloud.form.keyLabel")}
        <input
          type="password"
          autoComplete="off"
          value={key}
          onChange={(event) => setKey(event.target.value)}
          disabled={busy}
          className="focus-ring rounded-lg border border-hairline bg-surface px-3 py-2 font-mono text-sm text-heading"
        />
      </label>
      <p className="text-xs leading-relaxed text-muted">{t("cloud.form.sentOnce")}</p>
      {error !== null && (
        <p role="alert" className="text-xs font-medium text-heading">
          {error === "needsPro"
            ? t("cloud.needsPro.body")
            : error === "disabled"
              ? t("cloud.disabled")
              : error === "invalidKey"
                ? t("cloud.form.error")
                : t("cloud.unavailable")}
        </p>
      )}
      <Button tone="primary" onClick={submit} disabled={busy || key.trim() === "" || label.trim() === ""}>
        {busy ? t("cloud.form.submitting") : t("cloud.form.submit")}
      </Button>
    </div>
  );
}

/* -------------------------------------------------------- Connect OpenRouter */

function ConnectOpenRouter({ t }: { t: ReturnType<typeof useTranslations> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  const connect = useCallback(() => {
    setBusy(true);
    setError(false);
    void buildOpenRouterAuthorization()
      .then(({ url, nonce, verifier }) => {
        storeOpenRouterVerifier(nonce, verifier);
        window.location.assign(url);
      })
      .catch(() => {
        setBusy(false);
        setError(true);
      });
  }, []);

  return (
    <div className="mt-4 flex items-center justify-between gap-4 border-t border-hairline pt-4">
      <div>
        <p className="text-sm font-medium text-heading">{t("cloud.openRouter.title")}</p>
        <p className="text-xs leading-relaxed text-muted">{t("cloud.openRouter.body")}</p>
        {error && (
          <p role="alert" className="mt-1 text-xs font-medium text-heading">
            {t("cloud.openRouter.error")}
          </p>
        )}
      </div>
      <Button tone="ghost" onClick={connect} disabled={busy}>
        {busy ? t("cloud.openRouter.connecting") : t("cloud.openRouter.connect")}
      </Button>
    </div>
  );
}

/* --------------------------------------------------------------- the panel */

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; rows: CloudMeterKey[] }
  | { kind: "failed"; reason: CloudMeterFailure };

export function CloudMeterPanel({
  client,
  onStartTrial,
}: {
  client: SupabaseClient | null;
  onStartTrial: () => void;
}) {
  const t = useTranslations("hub");
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  const refresh = useCallback(() => {
    if (client === null) return;
    setState({ kind: "loading" });
    void listCloudKeys(client).then((result) => {
      setState(result.ok ? { kind: "ready", rows: result.value } : { kind: "failed", reason: result.reason });
    });
  }, [client]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  if (client === null) return null;

  return (
    <Panel title={t("cloud.title")} description={t("cloud.lead")}>
      {state.kind === "loading" && <p className="text-sm text-muted">{t("cloud.unavailable")}</p>}

      {state.kind === "failed" && state.reason === "needsPro" && (
        <div className="space-y-3">
          <p className="text-sm text-muted">{t("cloud.needsPro.body")}</p>
          <StartTrialButton onStart={onStartTrial} />
        </div>
      )}

      {state.kind === "failed" && state.reason === "disabled" && (
        <p className="text-sm text-muted">{t("cloud.disabled")}</p>
      )}

      {state.kind === "failed" && state.reason === "unavailable" && (
        <p className="text-sm text-muted">{t("cloud.unavailable")}</p>
      )}

      {state.kind === "ready" && (
        <>
          {state.rows.length === 0 ? (
            <p className="text-sm text-muted">{t("cloud.empty")}</p>
          ) : (
            <ul className="ol-directory-list">
              {state.rows.map((row) => (
                <CloudKeyRow
                  key={row.id}
                  row={row}
                  t={t}
                  onPollNow={(id) => {
                    return pollCloudKeyNow(client, id).then((result) => {
                      if (result.ok) refresh();
                      return result.ok;
                    });
                  }}
                  onDelete={(id) => {
                    return deleteCloudKey(client, id).then((result) => {
                      if (result.ok) refresh();
                      return result.ok;
                    });
                  }}
                />
              ))}
            </ul>
          )}
          <CloudKeyForm client={client} onAdded={refresh} t={t} />
          <ConnectOpenRouter t={t} />
        </>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------- the bars view */

/**
 * Cloud metered spend, in the bars view: a small cloud glyph, the key's own
 * label, and the same dollar row every other reading in this product draws.
 *
 * Every stored key draws a row here, polled or not: a key with no amount and
 * currency yet reads "First poll pending" (reused from the same status this
 * catalog already carries for Configuration) rather than being left out, so a
 * key that was just added is never mistaken for one that does not exist. This
 * surface still only ever shows a reading or the honest absence of one, never
 * a number it made up.
 */
export function CloudSpendRows({ rows, now, failed = false }: { rows: CloudMeterKey[]; now: string; failed?: boolean }) {
  const t = useTranslations("hub");

  if (rows.length === 0) return null;

  return (
    <div className="ol-device-money">
      {rows.map((row) => <CloudSpendRow key={row.id} row={row} now={now} failed={failed} t={t} />)}
    </div>
  );
}

function formatCloudAmount(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, {
      style: "currency",
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}
