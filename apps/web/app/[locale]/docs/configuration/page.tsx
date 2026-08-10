import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub, Table } from "@/components/docs/prose";
import {
  CAPTURED_ON,
  configCapture,
  statuslineCapture,
  statuslineNarrowCapture,
  statuslinePlainCapture,
} from "@/lib/cli-capture";
import { docMetadata } from "@/lib/metadata";

export const metadata: Metadata = docMetadata("/docs/configuration");

export default function ConfigurationPage() {
  return (
    <DocArticle
      href="/docs/configuration"
      title="Configuration"
      lead="OpenLimiter keeps everything in one state directory under your own user account: a configuration file, a cache, a lock, and the optional manual document. This page says where that is and what each file does."
      sections={[
        {
          id: "state-directory",
          title: "The state directory",
          body: (
            <>
              <Table
                caption="Where the state directory lives on each platform"
                columns={[
                  { key: "platform", header: "platform" },
                  { key: "path", header: "path" },
                ]}
                rows={[
                  {
                    platform: "Windows",
                    path: <Code>%LOCALAPPDATA%\openlimiter</Code>,
                  },
                  {
                    platform: "macOS",
                    path: <Code>~/Library/Application Support/openlimiter</Code>,
                  },
                  {
                    platform: "Linux",
                    path: <Code>${"{XDG_STATE_HOME:-~/.local/state}"}/openlimiter</Code>,
                  },
                ]}
              />
              <P>
                The directory is created with restrictive permissions where the platform supports
                them. A path that turns out to be a symbolic link is rejected rather than followed.
              </P>
            </>
          ),
        },
        {
          id: "files",
          title: "What lives in it",
          body: (
            <Table
              caption="Files inside the state directory"
              columns={[
                { key: "file", header: "file" },
                { key: "role", header: "role" },
              ]}
              rows={[
                {
                  file: <Code>openlimiter-config.json</Code>,
                  role: (
                    <>
                      Written by <Code>openlimiter init</Code>. Records the connector list, whether
                      each one was detected, and the statusline layout.
                    </>
                  ),
                },
                {
                  file: <Code>openlimiter-cache.json</Code>,
                  role: "The one cache every command reads and every writer merges into.",
                },
                {
                  file: <Code>openlimiter.lock</Code>,
                  role: "Held by writers only. Readers never take it.",
                },
                {
                  file: <Code>manual.json</Code>,
                  role: (
                    <>
                      Optional. Quota you maintain by hand. See{" "}
                      <DocLink href="/docs/ingestion">ingestion</DocLink> for the shape.
                    </>
                  ),
                },
              ]}
            />
          ),
        },
        {
          id: "cache-behaviour",
          title: "How the cache behaves",
          body: (
            <>
              <Bullets
                items={[
                  <>
                    One schema, one file, one lock. There are no competing state files to reconcile.
                  </>,
                  <>
                    Readers never take the lock. A reader opens the file, validates that open
                    descriptor, and reads through it, so a path swapped after the check cannot
                    redirect the bytes.
                  </>,
                  <>
                    Writers take the lock, and the read, the merge, and the write all happen inside
                    it. A lock older than five seconds is treated as abandoned and reclaimed.
                  </>,
                  <>
                    Every replacement flushes to stable storage before the rename, so a reader
                    observes either the previous content or the new content and never a partial
                    file.
                  </>,
                ]}
              />
              <P>
                Cache health is visible at any time through <Code>openlimiter doctor</Code>, which
                prints the cache status and how many rows were dropped for failing validation.
              </P>
            </>
          ),
        },
        {
          id: "statusline",
          title: "The statusline layout",
          body: (
            <>
              <P>
                The statusline draws one compact cell per provider: a name, a five block bar, and
                the percentage, with the overall reason code and the routing recommendation leading
                the row. Six keys in the configuration file decide how that row is built, and{" "}
                <Code>openlimiter config</Code> is how they are read and changed.
              </P>
              <CodeBlock
                label={`captured ${CAPTURED_ON}, synthetic fixtures`}
                code={`${statuslineCapture.command}\n${statuslineCapture.output}`}
              />
              <Sub id="statusline-keys">Every key</Sub>
              <Table
                caption="The statusline keys and what each one accepts"
                columns={[
                  { key: "key", header: "key" },
                  { key: "accepts", header: "accepts" },
                  { key: "meaning", header: "meaning" },
                ]}
                rows={[
                  {
                    key: <Code>order</Code>,
                    accepts: (
                      <>
                        provider ids, comma separated, or <Code>NONE</Code>
                      </>
                    ),
                    meaning: (
                      <>
                        The order the cells appear in. Whatever you list comes first; every
                        provider you leave out follows the built in order behind it, which is the
                        subscription plans and then the credit and API meters.{" "}
                        <Code>NONE</Code> is the way back to that built in order. Default{" "}
                        <Code>NONE</Code>.
                      </>
                    ),
                  },
                  {
                    key: <Code>meters</Code>,
                    accepts: (
                      <>
                        <Code>worst</Code> or <Code>all</Code>
                      </>
                    ),
                    meaning: (
                      <>
                        A provider with several meters shows the one closest to its cap, or all of
                        them as separate cells named <Code>PROVIDER:METER</Code>. Meters order
                        session, daily, weekly, monthly, credits. Default <Code>worst</Code>.
                      </>
                    ),
                  },
                  {
                    key: <Code>width</Code>,
                    accepts: "a whole number from 40 to 400",
                    meaning: (
                      <>
                        The columns one row may spend before the line stacks. Nothing measures your
                        terminal: a statusline host runs the command with no terminal attached, so
                        the number here is the number honoured. Default <Code>140</Code>.
                      </>
                    ),
                  },
                  {
                    key: <Code>rows</Code>,
                    accepts: (
                      <>
                        <Code>1</Code> or <Code>2</Code>
                      </>
                    ),
                    meaning: (
                      <>
                        How many rows the layout may use. Default <Code>2</Code>.
                      </>
                    ),
                  },
                  {
                    key: <Code>bars</Code>,
                    accepts: (
                      <>
                        <Code>true</Code> or <Code>false</Code>
                      </>
                    ),
                    meaning: (
                      <>
                        False restores the single plain line from 0.1.0, byte for byte. Default{" "}
                        <Code>true</Code>.
                      </>
                    ),
                  },
                  {
                    key: <Code>color</Code>,
                    accepts: (
                      <>
                        <Code>auto</Code>, <Code>always</Code>, or <Code>never</Code>
                      </>
                    ),
                    meaning: (
                      <>
                        <Code>auto</Code> follows the terminal, which for a statusline host usually
                        means no colour, because the host captures the output rather than handing
                        the command a terminal. <Code>always</Code> is how you say the host
                        understands escape codes. Default <Code>auto</Code>.
                      </>
                    ),
                  },
                ]}
              />
              <Callout tone="key" title="NO_COLOR beats always">
                The environment variable is the one setting a person makes once for every tool on
                the machine, so a configuration file inside one tool does not overrule it. With{" "}
                <Code>NO_COLOR</Code> set, the bars are drawn in <Code>#</Code> and <Code>.</Code>{" "}
                and no escape code is emitted at all.
              </Callout>
              <Sub id="statusline-commands">Reading and writing them</Sub>
              <CodeBlock
                label={`captured ${CAPTURED_ON}`}
                code={`${configCapture.command}\n${configCapture.output}`}
              />
              <P>
                One key at a time, validated before it is written. A value the key cannot use exits
                2 and names what it wanted, and nothing partial is written, because the whole
                document is replaced atomically. Statusline keys are the only thing this command
                mutates: the connector list belongs to <Code>openlimiter init</Code>, and any other
                key exits 2.
              </P>
              <CodeBlock
                code={`openlimiter config set statusline.order codex,claude
statusline.order=codex,claude

openlimiter config set statusline.meters all
statusline.meters=all

openlimiter config set statusline.width 12
openlimiter config: statusline.width must be a whole number from 40 to 400.

openlimiter config set statusline.theme dark
openlimiter config: unknown statusline key. Known keys: order, meters, width, rows, bars, color.`}
              />
              <P>
                Re running <Code>openlimiter init</Code> keeps whatever is configured here and only
                redetects the connectors. A statusline key this version cannot read falls back to
                its default rather than stopping the draw, so a hand edited typo in one field never
                costs you the other five.
              </P>
              <Sub id="statusline-stacking">When the row runs out of room</Sub>
              <P>
                The line stacks instead of truncating. A break lands between two cells and never
                inside one, and two rows is the ceiling. Past that the providers closest to their
                caps are the ones kept, and the last row ends by saying how many it could not show.
              </P>
              <CodeBlock
                label={`captured ${CAPTURED_ON}, synthetic fixtures`}
                code={`${statuslineNarrowCapture.command}\n${statuslineNarrowCapture.output}`}
              />
              <Sub id="statusline-plain">The 0.1.0 line, on request</Sub>
              <P>
                The format before this layout was one plain line with no bars. If you wrote a
                script against it, <Code>bars false</Code> returns it exactly, and a test pins that
                exact string so it cannot drift.
              </P>
              <CodeBlock
                label={`captured ${CAPTURED_ON}, synthetic fixtures`}
                code={`${statuslinePlainCapture.command}\n${statuslinePlainCapture.output}`}
              />
            </>
          ),
        },
        {
          id: "claude-code",
          title: "Claude Code settings",
          body: (
            <>
              <P>
                Use the absolute path to your clone. Forward slashes work on every platform,
                including Windows.
              </P>
              <CodeBlock
                label="settings.json"
                code={`{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js statusline"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js hook"
          }
        ]
      }
    ]
  }
}`}
              />
              <Sub id="which-writes">Which of the two writes</Sub>
              <P>
                Only the statusline. It is the path that receives the session payload, so it is the
                path that updates the cache. The hook reads and never writes.
              </P>
            </>
          ),
        },
        {
          id: "credentials",
          title: "Credentials",
          body: (
            <>
              <Callout tone="key" title="Keys belong in the operating system credential store">
                The only credential OpenLimiter has any concept of is an OpenRouter key, and it
                belongs in your operating system credential store. It must never appear in
                repository files, cache files, exports, diagnostics, fixtures, or logs. Provider
                authentication artifacts are opened read only and are never rewritten, backed up,
                repaired, or migrated.
              </Callout>
              <P>
                The credential library call sits behind an interface, and the adapter is stubbed in
                this release, so <Code>openlimiter init</Code> cannot store a key until a driver is
                supplied. Nothing else on your machine is touched.
              </P>
            </>
          ),
        },
        {
          id: "detection",
          title: "Connector detection",
          body: (
            <>
              <P>
                Detection is a pure function of the environment the CLI hands a connector. Facts
                only the CLI can observe, such as a manual document sitting in the state directory,
                arrive as explicit markers, which is why <Code>openlimiter doctor</Code> never
                claims a connector is ready when it could not receive data.
              </P>
              <CodeBlock
                label="terminal"
                code={`openlimiter doctor
CONNECTOR DETECTED FRESHNESS DRIFT
claude no unknown UNVERIFIED
openrouter no unknown UNVERIFIED
codex no unknown UNVERIFIED
antigravity no unknown UNVERIFIED
opencode no unknown UNVERIFIED
manual yes fresh UNVERIFIED
CACHE ok DROPPED 0`}
              />
              <P>
                A cache that would not parse, or one that parsed with rows thrown out, adds one
                more line in red saying so. It reports against the cache rather than against a
                provider, because a corrupt file cannot be trusted to say whose reading it held.
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
