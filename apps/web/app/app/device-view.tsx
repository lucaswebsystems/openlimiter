"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  buildProviderAccountRows,
  parseQuotaText,
  PROVIDER_CODES,
  type Snapshot,
} from "./engine";
import { HeaderStrip, Panel, ProviderRows, SkeletonRows, observationAgeMinutes } from "./pieces";
import { claudeMeterOverride, meterName, type ClaudeMeterCopy } from "./language";
import { ThemeToggle } from "@/components/theme-toggle";
import { clearDeviceSession, readDeviceSession } from "@/lib/device-session";
import {
  amountRows,
  formatAmount,
  meterRowsOf,
  snapshotFromMeterRow,
  type MeterRow,
} from "@/lib/device-snapshots";
import { readDeviceSnapshots } from "@/lib/pro-device";
import { useTranslations } from "next-intl";
import { visibleQuotaSnapshots } from "./live-usage";
import { useClaudeMeterCopy } from "./use-claude-meter-copy";

/**
 * The dashboard, for a phone that was paired rather than signed in.
 *
 * There is no account session here and there never will be: the phone holds a
 * read scoped device token and nothing else, so it can read the meters this
 * account already synced and it can do nothing at all besides. Every reading on
 * screen comes from the hosted read, goes through the same normalizer the
 * pasted document path uses, and is drawn by the same row element the desktop
 * and the browser dashboard draw, so one reading cannot look like two different
 * readings on two screens.
 *
 * A revoked device is the state this view is designed around rather than the
 * state it apologises for. The server answers 401, the token is removed from
 * this browser on the spot, and the screen says what happened in one sentence
 * with the way back under it.
 */

type ViewState = "loading" | "ready" | "unpaired" | "unavailable";

/** Percentage rows are drawn by the engine, so only these providers qualify. */
const ENGINE_PROVIDERS: readonly string[] = PROVIDER_CODES;

/** How often a phone left open asks again. */
const REFRESH_MILLISECONDS = 60_000;

function MoneyRow({ row, locale, claudeMeterCopy }: { row: MeterRow; locale: string; claudeMeterCopy: ClaudeMeterCopy }) {
  const amount = formatAmount(row, locale);
  return (
    <div className="ol-device-money-row">
      <span className="ol-device-money-name">
        {row.provider} {meterName(row.code, row.provider, claudeMeterCopy)}
      </span>
      <span className="ol-device-money-value" data-state={row.stale ? "stale" : "fresh"}>
        {amount ?? "unknown"}
      </span>
    </div>
  );
}

function Notice({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="ol-device-notice">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function DeviceView({ lockup }: { lockup: ReactNode }) {
  const [state, setState] = useState<ViewState>("loading");
  const [snapshots, setSnapshots] = useState<readonly Snapshot[]>([]);
  const [money, setMoney] = useState<readonly MeterRow[]>([]);
  const [now, setNow] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locale = useRef("en");
  const readingsT = useTranslations("hub");
  const claudeMeterCopy = useClaudeMeterCopy();

  useEffect(() => {
    locale.current = navigator.language || "en";
  }, []);

  const read = useCallback(() => {
    const session = readDeviceSession();
    if (session === null) {
      setState("unpaired");
      return;
    }
    setBusy(true);
    void readDeviceSnapshots(session.token).then((response) => {
      setBusy(false);
      if (response.status === 401 || response.status === 403) {
        clearDeviceSession();
        setState("unpaired");
        return;
      }
      if (response.status !== 200) {
        setState("unavailable");
        return;
      }
      const rows = meterRowsOf(response.body);
      const raw = rows.map(snapshotFromMeterRow).filter((row) => row !== null);
      const parsed = parseQuotaText(JSON.stringify(raw), new Date().toISOString());
      setSnapshots(parsed.ok ? parsed.snapshots : []);
      setMoney(amountRows(rows, ENGINE_PROVIDERS));
      setNow(new Date().toISOString());
      setState("ready");
    });
  }, []);

  useEffect(() => {
    read();
    const timer = window.setInterval(read, REFRESH_MILLISECONDS);
    window.addEventListener("focus", read);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", read);
    };
  }, [read]);

  const shown = useMemo(
    () => now === null
      ? []
      : visibleQuotaSnapshots(snapshots, now, (count) => readingsT("accountFallback", { count })),
    [snapshots, now, readingsT],
  );

  const rows = useMemo(
    () => (now === null ? [] : buildProviderAccountRows(shown, now, [], {
      accountLabel: (_accountId, count) => readingsT("accountFallback", { count }),
      meterLabel: (code, provider) => claudeMeterOverride(code, provider, claudeMeterCopy),
      updatedLabel: (observedAt) => {
        const age = observationAgeMinutes(observedAt, now);
        if (age === null || age < 5) return null;
        if (age < 60) return readingsT("updatedMinutes", { count: age });
        if (age < 1_440) return readingsT("updatedHours", { count: Math.floor(age / 60) });
        return readingsT("updatedDays", { count: Math.floor(age / 1_440) });
      },
    })),
    [shown, now, readingsT, claudeMeterCopy],
  );

  return (
    <div className="ol-dashboard">
      <HeaderStrip
        lockup={lockup}
        busy={busy}
        onRefresh={read}
        showRefresh={state === "ready"}
        actions={<ThemeToggle className="h-9 w-9" />}
      />

      {state === "loading" && <SkeletonRows />}

      {state === "unpaired" && (
        <Notice title="Unpaired. Scan again to pair.">
          <p>
            This phone no longer holds a grant, so nothing is being read. Generate a fresh code on
            the desktop application and scan it again.
          </p>
          <p>
            <Link href="/en/docs">Read how pairing works</Link>
          </p>
        </Notice>
      )}

      {state === "unavailable" && (
        <Notice title="The service did not answer">
          <p>
            Your pairing is intact and nothing changed. This phone will try again on its own, or you
            can pull the page to reload it.
          </p>
        </Notice>
      )}

      {state === "ready" && (
        <div className="ol-panel">
          <div className="ol-home-stack">
            <ProviderRows
              rows={rows}
              orderScope={{ kind: "paired", id: "current-device" }}
              reorderable
              claudeFableHintText={readingsT("claudeFableDesktopHint")}
            />
            {money.length > 0 && (
              <Panel
                title="Spend and balance"
                description="Money the account reports, kept apart from the percentage windows."
              >
                <div className="ol-device-money">
                  {money.map((row) => (
                    <MoneyRow key={`${row.provider}:${row.accountId}:${row.code}`} row={row} locale={locale.current} claudeMeterCopy={claudeMeterCopy} />
                  ))}
                </div>
              </Panel>
            )}
            {shown.length === 0 && money.length === 0 && (
              <Notice title="Nothing has synced yet">
                <p>
                  This account has no reading to show on a phone. Open OpenLimiter on the computer
                  that holds your providers and let it sync once.
                </p>
              </Notice>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
