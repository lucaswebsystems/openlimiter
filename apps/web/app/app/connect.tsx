"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { buildProviderDirectory } from "./engine";
import { BandHorizon } from "./horizon";
import { ProviderMark } from "./marks";
import { BROWSER_PROVIDER_STATES, Button, providerMarkCode } from "./pieces";
import registry from "../../lib/provider-specs.generated.json";
import { CONNECT_COMMAND } from "@/lib/onboarding";

/**
 * Connecting an account, as the browser can honestly offer it.
 *
 * A browser cannot read a command line tool's credential file, cannot see
 * which agent is installed on the machine in front of it, and cannot run a
 * vendor's own login. So this screen does not pretend to: it names every
 * provider the product reads, says in one line where that connection is
 * actually made, and hands over the one command that makes it. The desktop
 * application and the terminal do the work; the hub shows what they synced.
 *
 * The command is a literal rather than a message, the same way a file path or
 * a flag is: it is typed into a shell, so it is identical in every language.
 */

/** Whether the clipboard took the text. A refusal is a state, not an error. */
async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * One command, with the button that takes it.
 *
 * The button says what happened rather than firing a toast at somebody, and it
 * says it for two seconds, which is long enough to read and short enough that
 * a second copy is never blocked by the answer to the first.
 *
 * A refusal is drawn too. A browser without the clipboard interface, or one
 * whose permission was denied, used to leave the label alone and look like a
 * button that does nothing; instead it says what happened and points at the
 * command, which is selectable as a whole by design.
 */
export function CopyCommand({ command }: { command: string }) {
  const t = useTranslations("hub");
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state !== "copied") return undefined;
    const timer = window.setTimeout(() => setState("idle"), 2000);
    return () => {
      window.clearTimeout(timer);
    };
  }, [state]);

  return (
    <div className="ol-command-block">
      <div className="ol-command">
        {/* Selectable as one word, so the sentence below is a real instruction
            rather than an apology: one click takes the whole command. */}
        <code>{command}</code>
        <Button
          tone="ghost"
          onClick={() => {
            void writeClipboard(command).then((ok) => {
              setState(ok ? "copied" : "failed");
            });
          }}
        >
          <span aria-live="polite">
            {state === "copied" ? t("command.copied") : t("command.copy")}
          </span>
        </Button>
      </div>
      {state === "failed" && (
        <p role="status" aria-live="polite" className="ol-command-note">
          {t("command.failed")}
        </p>
      )}
    </div>
  );
}

/**
 * Every provider the product reads, with the one line that says where.
 *
 * The list is the engine's own directory rather than a second list kept beside
 * it, so a provider that arrives in the connector table arrives here with no
 * edit to this file. Only the rows that are ready are drawn: a roadmap entry
 * is a promise, and a promise does not belong on a screen whose job is to get
 * somebody connected today.
 */
export function ConnectList() {
  const t = useTranslations("hub");
  const rows = buildProviderDirectory(registry, { states: BROWSER_PROVIDER_STATES }).filter(
    (row) => row.availability === "ready",
  );

  return (
    <div className="ol-connect">
      <CopyCommand command={CONNECT_COMMAND} />
      <ul className="ol-connect-rows">
        {rows.map((row) => (
          <li key={row.key} className="ol-connect-row">
            <span className="ol-provider-mark" data-provider={providerMarkCode(row)}>
              <ProviderMark provider={providerMarkCode(row)} label={row.displayName} />
            </span>
            <span className="ol-connect-name">
              <strong>{row.displayName}</strong>
              {/*
                One sentence, and only the one that is actually true for this
                row. OpenRouter connects by its own OAuth rather than a
                terminal login, so it reads with the key style sentence
                (Configuration carries its real Connect button); every other
                key provider does too; everything else is a subscription read
                through the tool's own login, named so seven rows never say
                the same unnamed sentence.
              */}
              <span>
                {row.access === "key" || row.specId === "openrouter/api"
                  ? t("connect.key")
                  : t("connect.terminal", { tool: row.displayName })}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {/* next/link directly rather than the site's link component: this route
          renders its own document and is never localised, so there is no
          locale prefix to work out here. It is the same link the settings menu
          in pieces.tsx makes, for the same reason. */}
      <p className="text-xs leading-relaxed text-muted">
        {t("connect.noDesktop")}{" "}
        <Link
          href="/en/download"
          className="focus-ring rounded-sm font-medium text-heading underline decoration-hairline-strong underline-offset-4 hover:decoration-heading"
        >
          {t("connect.getDesktop")}
        </Link>
      </p>
    </div>
  );
}

/**
 * What the bars view says before a device has synced anything.
 *
 * One sentence and one command, over the horizon. There is deliberately no
 * button here and no list of providers: the sentence says what to run, the
 * block runs it, and everything else on this screen would be a second thing to
 * decide at the moment somebody has nothing to look at.
 */
export function BarsEmpty() {
  const t = useTranslations("hub");
  return (
    <section className="ol-bars-empty ol-rise">
      <BandHorizon />
      <p>{t("empty.line")}</p>
      <CopyCommand command={CONNECT_COMMAND} />
    </section>
  );
}
