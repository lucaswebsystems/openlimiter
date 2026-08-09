import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub, Table } from "@/components/docs/prose";
import { CAPTURED_ON, demoCapture } from "@/lib/cli-capture";
import { findDocPage } from "@/lib/docs";

const page = findDocPage("/docs/cli");

export const metadata: Metadata = {
  title: page?.title,
  description: page?.description,
  alternates: { canonical: "/docs/cli" },
};

export default function CliPage() {
  return (
    <DocArticle
      href="/docs/cli"
      title="CLI reference"
      lead="Eight commands, one binary. Agent tools and people get the same interface, and every command reports a genuine failure rather than inventing a number."
      sections={[
        {
          id: "overview",
          title: "Overview",
          body: (
            <>
              <CodeBlock
                label="openlimiter help"
                code={`openlimiter init
openlimiter snapshot [--refresh]
openlimiter statusline
openlimiter hook [--dry-run]
openlimiter ingest [--provider <id>] [--payload <json>]
openlimiter doctor
openlimiter demo
openlimiter export

statusline and ingest read JSON from standard input when it is piped in.
Exit codes: 0 success, 1 failure, 2 usage, 3 no bounded quota data.`}
              />
              <P>
                The package is not published yet, so run these as{" "}
                <Code>pnpm openlimiter &lt;command&gt;</Code> or{" "}
                <Code>node packages/cli/dist/bin.js &lt;command&gt;</Code> from the repository root.
              </P>
            </>
          ),
        },
        {
          id: "commands",
          title: "The commands",
          body: (
            <>
              <Sub id="init">init</Sub>
              <P>
                Writes local configuration to the state directory, recording every connector and
                whether it was detected. It reports the detected list, or none.
              </P>
              <CodeBlock code={`openlimiter init
Configuration saved. Detected: manual`} />

              <Sub id="snapshot">snapshot</Sub>
              <P>
                Prints the cached quota as a table. With <Code>--refresh</Code> it first asks every
                connector for meters, folds what survives validation into the cache, and then
                prints. Exits 3 when no bounded quota data exists.
              </P>
              <CodeBlock
                label="synthetic values"
                code={`openlimiter snapshot
PROVIDER METER USAGE STATE RESET
CLAUDE FIVE_HOUR 42.00PERCENT fresh 2026-08-09T20:35:37.671Z
CLAUDE SEVEN_DAY 64.00PERCENT fresh 2026-08-16T15:35:37.671Z`}
              />

              <Sub id="statusline">statusline</Sub>
              <P>
                Renders one line for a statusline host. It reads standard input first, so a Claude
                Code session payload is ingested and rendered in the same call, then falls back to
                the cache. This is the only command that writes as a side effect of being displayed.
              </P>

              <Sub id="hook">hook</Sub>
              <P>
                Emits the agent context block from the cache. It performs no network access, writes
                nothing, and injects nothing when every provider is unknown. See{" "}
                <DocLink href="/docs/agent-context">agent context</DocLink> for the exact format.
              </P>

              <Sub id="ingest">ingest</Sub>
              <P>
                Accepts a quota document from any script or agent, on standard input or inline with{" "}
                <Code>--payload</Code>. Without <Code>--provider</Code> the document is a manual
                document. With it, the document goes to that connector&apos;s parser and keeps that
                connector&apos;s labels.
              </P>
              <CodeBlock
                code={`openlimiter ingest --payload '{"meters":[{"name":"AGENT_BUDGET","used_percent":12.5,"reset_at":"2026-08-09T13:11:30.141Z"}]}'
Ingested 1 bounded meters. Cached meters: 3.`}
              />

              <Sub id="doctor">doctor</Sub>
              <P>
                Reports connector detection, freshness, drift, and cache health. Drift stays{" "}
                <Code>UNVERIFIED</Code> until an explicit verifier exists, and the output is
                redacted by design.
              </P>

              <Sub id="demo">demo</Sub>
              <P>
                Renders synthetic fixtures so you can see the output shape without any real
                account. Every value it prints is invented. The block below is the real output of
                that command, pasted in unedited.
              </P>
              <CodeBlock
                label={`captured ${CAPTURED_ON}, synthetic fixtures`}
                code={`${demoCapture.command}\n${demoCapture.output}`}
              />

              <Sub id="export">export</Sub>
              <P>
                Prints the cache as canonical JSON, suitable for a script to parse. Exits 3 when the
                cache holds no bounded quota data.
              </P>
            </>
          ),
        },
        {
          id: "exit-codes",
          title: "Exit codes",
          body: (
            <>
              <Table
                caption="Exit codes and what they mean"
                columns={[
                  { key: "code", header: "code" },
                  { key: "meaning", header: "meaning" },
                ]}
                rows={[
                  { code: <Code>0</Code>, meaning: "Success." },
                  { code: <Code>1</Code>, meaning: "A genuine failure." },
                  { code: <Code>2</Code>, meaning: "A usage error, such as an unknown provider id." },
                  { code: <Code>3</Code>, meaning: "No bounded quota data is available." },
                ]}
              />
              <Callout tone="key" title="hook and statusline always exit 0">
                Both are invoked by another tool, so they report unknown instead of breaking their
                host. Every other command surfaces a failure on standard error using a fixed set of
                strings that never carry provider text, paths taken from a payload, or secrets.
              </Callout>
            </>
          ),
        },
        {
          id: "notes",
          title: "Behaviour worth knowing",
          body: (
            <Bullets
              items={[
                <>
                  Standard input is bounded and time limited, so a command never waits on a stream
                  that does not end.
                </>,
                <>
                  Displayed percentages are truncated rather than rounded, so no surface can report
                  a cap that was not reached.
                </>,
                <>
                  <Code>--provider</Code> and <Code>--payload</Code> each need a value. Passing the
                  flag without one is a usage error.
                </>,
                <>
                  In this release no command reaches the network. Every path is a parser over
                  something already on your machine.
                </>,
              ]}
            />
          ),
        },
      ]}
    />
  );
}
