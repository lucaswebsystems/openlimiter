"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { CURRENT_VERSION } from "@/lib/site";
import { endPhoneSession } from "@/lib/phone-session";
import { ThemeChoice } from "@/components/theme-choice";
import { InstallControl, type InstallControlHandle } from "../install";
import { Sheet } from "../sheet";

function GearGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.6 3.4h4.8l.7 2.2 2 .9 2.1-1 2.4 4.1-1.6 1.5v2.2l1.6 1.5-2.4 4.1-2.1-1-2 .9-.7 2.2H9.6l-.7-2.2-2-.9-2.1 1-2.4-4.1L4 13.3v-2.2L2.4 9.6l2.4-4.1 2.1 1 2-.9.7-2.2Z" />
      <circle cx="12" cy="12.2" r="3.1" />
    </svg>
  );
}

export function PhoneSettings({ label, onUnpaired }: { label: string; onUnpaired: () => void }) {
  const t = useTranslations("hub.phoneSettings");
  const [open, setOpen] = useState(false);
  const [installed, setInstalled] = useState(false);
  const [busy, setBusy] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const install = useRef<InstallControlHandle | null>(null);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="ol-phone-gear focus-ring"
        aria-label={t("open")}
        title={t("open")}
        onClick={() => setOpen(true)}
      ><GearGlyph /></button>
      <Sheet open={open} title={t("title")} closeLabel={t("close")} onClose={() => setOpen(false)} returnFocus={trigger.current}>
        <dl className="ol-phone-settings-list">
          <div><dt>{t("pairedAs")}</dt><dd>{label}</dd></div>
          <div><dt>{t("theme.label")}</dt><dd><ThemeChoice /></dd></div>
          <div>
            <dt>{t("install")}</dt>
            <dd>
              <button
                type="button"
                className="ol-settings-action focus-ring"
                disabled={installed}
                onClick={() => {
                  setOpen(false);
                  window.setTimeout(() => install.current?.activate(trigger.current ?? undefined), 0);
                }}
              >{installed ? t("installed") : t("installAction")}</button>
            </dd>
          </div>
          <div><dt>{t("version")}</dt><dd>{CURRENT_VERSION}</dd></div>
        </dl>
        <button
          type="button"
          className="ol-settings-unpair focus-ring"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void endPhoneSession().finally(onUnpaired);
          }}
        >{busy ? t("unpairing") : t("unpair")}</button>
      </Sheet>
      <InstallControl ref={install} showButton={false} onInstalledChange={setInstalled} />
    </>
  );
}
