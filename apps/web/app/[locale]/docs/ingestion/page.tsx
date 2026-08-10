import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";

export const metadata: Metadata = docMetadata("/docs/ingestion");

export default function IngestionPage() {
  return (
    <DocArticle
      href="/docs/ingestion"
      title="Ingestion"
      lead="Three paths put quota data in front of OpenLimiter. All three are offline. None of them reaches the network, and until one of them runs, every command honestly reports unknown."
      sections={[
        {
          id: "statusline",
          title: "1. The Claude Code statusline payload",
          body: (
            <>
              <P>
                This is the path that needs no extra work once Claude Code is wired up. Claude Code
                runs your statusline command on every render and writes a JSON object describing
                the current session to that command&apos;s standard input. When that object carries
                a rate limit block, <Code>openlimiter statusline</Code> validates it, writes it to
                the cache, and renders the fresh numbers in the same call.
              </P>
              <CodeBlock
                label="the block it reads, from Anthropic's own statusline documentation"
                code={`{
  "rate_limits": {
    "five_hour": { "used_percentage": 23.5, "resets_at": 1738425600 },
    "seven_day": { "used_percentage": 41.2, "resets_at": 1738857600 }
  }
}`}
              />
              <P>
                <Code>used_percentage</Code> is the share of the window already used, from 0 to
                100. <Code>resets_at</Code> is a Unix epoch number in seconds, not a date string.
                Both field names and the epoch encoding come from Anthropic&apos;s published
                statusline documentation rather than from this project, and each window is
                independently optional: a payload naming only one of them is one complete meter,
                not a partial one.
              </P>
              <Bullets
                items={[
                  <>
                    <Code>rate_limits</Code> appears only for Claude.ai subscribers on a Pro or Max
                    plan, and only after the first API response of a session. A payload with no{" "}
                    <Code>rate_limits</Code> block is the ordinary shape of a free account or a
                    session that has not called the API yet, not an error.
                  </>,
                  <>
                    A reset implausibly far out for its own window, a five hour window resetting
                    days away, is dropped on its own rather than trusted. The other window still
                    counts.
                  </>,
                ]}
              />
              <P>
                Anything else in the session object is ignored. A window that fails validation is
                dropped and the other window still counts.
              </P>
              <Callout tone="key" title="This path can never break your statusline">
                If standard input is absent, empty, malformed, or carries no recognisable rate
                limit field, the statusline falls back to the cache and reports unknown. It never
                blocks and never fails. Not every Claude Code version sends rate limit fields; if
                yours does not, this path simply stays quiet.
              </Callout>
            </>
          ),
        },
        {
          id: "manual-document",
          title: "2. A manual document on disk",
          body: (
            <>
              <P>
                Write <Code>manual.json</Code> inside the state directory and every command picks
                it up. See <DocLink href="/docs/configuration">configuration</DocLink> for where
                that directory lives on each platform.
              </P>
              <CodeBlock
                label="manual.json"
                code={`{
  "version": 1,
  "meters": [
    { "name": "MONTHLY", "used_percent": 61.5, "reset_at": "2026-08-29T12:11:29.714Z" }
  ]
}`}
              />
              <Sub id="manual-rules">The rules each row must satisfy</Sub>
              <Bullets
                items={[
                  <>
                    <Code>name</Code> is one uppercase identifier of up to 32 characters, starting
                    with a letter.
                  </>,
                  <>
                    <Code>used_percent</Code> is a number from 0 to 100.
                  </>,
                  <>
                    <Code>reset_at</Code> is an ISO instant in the future.
                  </>,
                  <>Up to ten meters are read. Rows past the tenth are ignored.</>,
                  <>
                    A row that breaks any of those rules is dropped, and the remaining rows still
                    count. Nothing is repaired.
                  </>,
                ]}
              />
              <P>
                Run <Code>openlimiter snapshot --refresh</Code> to fold the file into the cache.
              </P>
            </>
          ),
        },
        {
          id: "ingest-command",
          title: "3. The generic ingest command",
          body: (
            <>
              <P>
                Any script or agent can hand OpenLimiter a document without a provider integration.
                The command reads standard input, or an inline document passed with{" "}
                <Code>--payload</Code>.
              </P>
              <CodeBlock
                label="terminal"
                code={`echo '{"meters":[{"name":"AGENT_BUDGET","used_percent":12.5,"reset_at":"2026-08-09T13:11:30.141Z"}]}' | openlimiter ingest

openlimiter ingest --payload '{"meters":[{"name":"AGENT_BUDGET","used_percent":12.5,"reset_at":"2026-08-09T13:11:30.141Z"}]}'`}
              />
              <P>
                Without a provider flag the document is treated as a manual document, so the
                resulting snapshot is labelled with manual precision. With{" "}
                <Code>--provider &lt;id&gt;</Code> the document is handed to that connector&apos;s
                own parser and keeps that connector&apos;s labels.
              </P>
              <CodeBlock
                label="terminal"
                code={`openlimiter ingest --provider codex --payload '{"rate_limits":{"primary_window":{"used_percent":33,"reset_at":"2026-08-09T14:11:30.264Z"}}}'`}
              />
              <P>
                Valid provider ids are <Code>claude</Code>, <Code>openrouter</Code>,{" "}
                <Code>codex</Code>, <Code>antigravity</Code>, <Code>opencode</Code>, and{" "}
                <Code>manual</Code>. An unknown id is a usage error and exits 2.
              </P>
            </>
          ),
        },
        {
          id: "merging",
          title: "What happens to the data",
          body: (
            <>
              <P>
                Ingested rows merge into one cache under the same lock every other writer uses, so
                nothing already cached is lost and two writers observing different providers cannot
                silently drop each other&apos;s rows.
              </P>
              <Bullets
                items={[
                  <>Values are validated against the snapshot schema before anything is written.</>,
                  <>
                    Percentages stay between 0 and 100. A value outside that range is not clamped,
                    it is dropped.
                  </>,
                  <>
                    Every write lands through an atomic replacement, so a reader observes either the
                    previous content or the new content and never a partial file.
                  </>,
                  <>
                    Freshness is derived from when a reading was observed and when it expires, so
                    stale data is labelled rather than silently reused as current.
                  </>,
                ]}
              />
              <P>
                Nothing survives validation? The command reports that no bounded meter survived and
                exits with a failure, rather than writing a placeholder.
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
