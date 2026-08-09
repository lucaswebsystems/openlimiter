import Link from "next/link";
import {
  AntigravityMark,
  ClaudeMark,
  CodexMark,
  OpenCodeMark,
  OpenRouterMark,
} from "./provider-marks";
import { SectionHeading } from "./ui";

/**
 * The agent grid.
 *
 * Five real connectors and one honest sixth. Every tile here corresponds to a
 * connector that ships in this release, and the dashed tile is a link rather
 * than a claim: manual entry is the path for everything without a connector.
 */

const tools = [
  { name: "Claude Code", Mark: ClaudeMark },
  { name: "OpenAI Codex", Mark: CodexMark },
  { name: "Google Antigravity", Mark: AntigravityMark },
  { name: "OpenCode", Mark: OpenCodeMark },
  { name: "OpenRouter", Mark: OpenRouterMark },
] as const;

const tile =
  "flex items-center justify-center gap-3 rounded-xl border border-hairline bg-surface px-5 py-4";

export function WorksWith() {
  return (
    <section id="providers">
      <SectionHeading
        title="Works with your tools"
        lead="One meter over every subscription you already hold. Each connector reads a shape that something on your machine already wrote, and in this release not one of them touches the network."
      />
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        {tools.map(({ name, Mark }) => (
          <div key={name} className={tile}>
            <span className="text-muted">
              <Mark />
            </span>
            <span className="text-sm font-medium text-heading">{name}</span>
          </div>
        ))}
        <Link
          href="/docs/providers"
          className={`focus-ring border-dashed text-sm font-medium text-muted transition-colors hover:text-heading ${tile}`}
        >
          and manual entry
        </Link>
      </div>
      <p className="mt-6 max-w-lg text-sm leading-relaxed text-muted">
        Every connector ships marked{" "}
        <span className="font-mono text-2xs text-heading">UNVERIFIED</span>, which is the honest
        default: no explicit verifier has confirmed a shape against a live account yet. Three of
        them read interfaces that are internal to somebody else&apos;s tooling and can change without
        notice, and when one does, that provider fails closed to unknown rather than guessing.
      </p>
    </section>
  );
}
