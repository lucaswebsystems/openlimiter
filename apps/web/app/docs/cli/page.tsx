import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub, Table } from "@/components/docs/prose";
import {
  CAPTURED_ON,
  configCapture,
  demoCapture,
  statuslineAllMetersCapture,
  statuslineCapture,
  statuslineNarrowCapture,
  statuslinePlainCapture,
} from "@/lib/cli-capture";
import { docMetadata } from "@/lib/metadata";

export const metadata: Metadata = docMetadata("/docs/cli");

export default function CliPage() {
  return (
    <DocArticle
      href="/docs/cli"
      title="CLI reference"
      lead="Ten commands, one binary. Agent tools and people get the same interface, and every command reports a genuine failure rather than inventing a number."
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
openlimiter config get statusline[.<key>]
openlimiter config set statusline.<key> <value>
openlimiter doctor
openlimiter demo
openlimiter export
openlimiter serve [--port <n>] [--host <address>] [--no-qr]

statusline keys: order, meters, width, rows, bars, color.
statusline and ingest read JSON from standard input when it is piped in.
Exit codes: 0 success, 1 failure, 2 usage, 3 no bounded quota data.`}
              />
              <P>
                Install the global command with <Code>npm install -g openlimiter</Code>, then run
                each example exactly as shown.
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
              <P>
                Eight columns, always eight, separated by one space, so a script can split a row
                without guessing. <Code>BAR</Code> is a ten block meter, drawn in colour when the
                terminal supports it and in <Code>#</Code> and <Code>.</Code> when it does not or
                when <Code>NO_COLOR</Code> is set. <Code>AMOUNT</Code> carries the money for a plan
                that is priced rather than rationed. <Code>RESET</Code> is the instant the window
                turns over and <Code>IN</Code> is how long that is from now. A column with nothing
                to say reads <Code>NONE</Code> rather than disappearing.
              </P>
              <CodeBlock
                label="synthetic values"
                code={`openlimiter snapshot
PROVIDER METER BAR USAGE AMOUNT STATE RESET IN
CLAUDE FIVE_HOUR ####...... 42.00PERCENT NONE fresh 2026-08-10T04:00:32.969Z 5h0m
CLAUDE SEVEN_DAY ######.... 64.00PERCENT NONE fresh 2026-08-16T23:00:32.969Z 7d0h
OPENROUTER CREDITS ######.... 62.35PERCENT $12.47/$20.00 fresh NONE NONE`}
              />
              <P>
                A connector that was handed a payload and could not read it, or a reading the
                validator threw out, adds one line under the table in red, naming the provider and
                one fixed sentence. That sentence is always one of ours: no text a provider sent
                ever reaches your terminal.
              </P>

              <Sub id="statusline">statusline</Sub>
              <P>
                Renders the status row for a statusline host. It reads standard input first, so a
                Claude Code session payload is ingested and rendered in the same call, then falls
                back to the cache. This is the only command that writes as a side effect of being
                displayed.
              </P>
              <P>
                The overall reason code leads, then the routing recommendation, then one compact
                cell per provider: a name, a five block bar, and the percentage. Five blocks rather
                than the ten the table draws, because a status row is shared with a model name, a
                branch and a directory, and it has to read at a glance. The percentage is truncated
                like everywhere else, so a bar never lights a block the reading has not earned.
              </P>
              <CodeBlock
                label={`captured ${CAPTURED_ON}, synthetic fixtures`}
                code={`${statuslineCapture.command}\n${statuslineCapture.output}`}
              />
              <P>
                Subscription providers come first and credit or API providers last, so a window
                that refills on a clock is never read next to a balance that does not come back.
                Within a provider the meters order session, daily, weekly, monthly, credits, and
                the cell shows the meter closest to its cap. The full set is one{" "}
                <Code>openlimiter snapshot</Code> away, or set{" "}
                <Code>statusline.meters all</Code> to put every meter in the row as its own cell.
              </P>
              <CodeBlock
                label={`captured ${CAPTURED_ON}, synthetic fixtures`}
                code={`${statuslineAllMetersCapture.command}\n${statuslineAllMetersCapture.output}`}
              />
              <P>
                A row wider than its budget stacks rather than truncating. The break lands between
                two cells and never inside one, because half a bar reads as a reading and is not
                one. Two rows is the ceiling. Past that the providers closest to their caps are
                kept, and the last row ends by saying how many it could not show.
              </P>
              <CodeBlock
                label={`captured ${CAPTURED_ON}, synthetic fixtures`}
                code={`${statuslineNarrowCapture.command}\n${statuslineNarrowCapture.output}`}
              />
              <Callout tone="key" title="The old line is still one setting away">
                <Code>openlimiter config set statusline.bars false</Code> returns the single plain
                line that 0.1.0 printed, byte for byte, for anything already parsing it. A test
                pins that exact string, so the escape hatch cannot rot quietly.
              </Callout>
              <CodeBlock
                label={`captured ${CAPTURED_ON}, synthetic fixtures`}
                code={`${statuslinePlainCapture.command}\n${statuslinePlainCapture.output}`}
              />

              <Sub id="config">config</Sub>
              <P>
                Reads and changes the statusline layout in the configuration file. Every key is
                validated before it is written, a rejected value exits 2 and names what it wanted,
                and nothing outside the statusline section can be changed by this command. See{" "}
                <DocLink href="/docs/configuration">configuration</DocLink> for what each key
                accepts.
              </P>
              <CodeBlock
                label={`captured ${CAPTURED_ON}`}
                code={`${configCapture.command}\n${configCapture.output}`}
              />
              <CodeBlock
                code={`openlimiter config set statusline.width 200
statusline.width=200

openlimiter config set statusline.rows 3
openlimiter config: statusline.rows must be 1 or 2.`}
              />

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

              <Sub id="serve">serve</Sub>
              <P>
                Serves a read only snapshot of your quota on your own local network, so a phone on
                the same network can see it. Prints the address and a QR code to scan, and every
                request needs the single use token baked into that address. It is meant for a
                trusted home or office network, never for the open internet, and it exposes only the
                bounded fields the agent context carries.
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
