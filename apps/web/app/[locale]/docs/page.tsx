import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Steps, Sub } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";

export const metadata: Metadata = docMetadata("/docs");

export default function GettingStartedPage() {
  return (
    <DocArticle
      href="/docs"
      title="Getting started"
      lead="OpenLimiter is a quota meter for the AI subscriptions you already pay for. It runs on your machine, reads what your tools already wrote there, and hands your coding agents a bounded picture of what budget is left."
      sections={[
        {
          id: "what-you-need",
          title: "What you need",
          body: (
            <>
              <Bullets
                items={[
                  <>Node 24 or newer.</>,
                  <>npm, which ships with Node.</>,
                ]}
              />
              <P>
                Everything runs locally. No account is created, no key is required to start, and
                no request leaves your machine during any of the steps below.
              </P>
            </>
          ),
        },
        {
          id: "install",
          title: "Install OpenLimiter",
          body: (
            <>
              <P>Install the command line tool globally, then run its synthetic demo.</P>
              <CodeBlock
                label="terminal"
                code={`npm install -g openlimiter
openlimiter demo`}
              />
              <P>
                <Code>openlimiter demo</Code> renders synthetic fixtures. It proves the binary
                works without touching any real account, and every number it prints is invented.
              </P>
            </>
          ),
        },
        {
          id: "first-data",
          title: "Give it something to meter",
          body: (
            <>
              <P>
                OpenLimiter never contacts a provider in this release. It parses data that
                something else already put in front of it. Until one of the ingestion paths runs,
                every command honestly reports unknown.
              </P>
              <P>
                The path that needs no extra work is the Claude Code statusline. Claude Code runs
                your statusline command on every render and writes a JSON object describing the
                current session to that command&apos;s standard input. When that object carries a
                rate limit block, OpenLimiter validates it, caches it, and renders the fresh
                numbers in the same call.
              </P>
              <CodeBlock
                label="terminal"
                code={`openlimiter statusline < session.json
OpenLimiter NEAR_CAP NONE UNKNOWN OPENROUTER,CODEX,ANTIGRAVITY,OPENCODE,MANUAL  CLAUDE ####. 87.5%`}
              />
              <P>
                Not every Claude Code version sends rate limit fields. If yours does not, this path
                stays quiet and the two manual paths still work. The{" "}
                <DocLink href="/docs/ingestion">ingestion page</DocLink>{" "}
                covers all three.
              </P>
            </>
          ),
        },
        {
          id: "claude-code",
          title: "Wire Claude Code",
          body: (
            <>
              <P>
                Add this to your Claude Code <Code>settings.json</Code>. The global install makes
                the <Code>openlimiter</Code> command available to Claude Code.
              </P>
              <CodeBlock
                label="settings.json"
                code={`{
  "statusLine": {
    "type": "command",
    "command": "openlimiter statusline"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "openlimiter hook"
          }
        ]
      }
    ]
  }
}`}
              />
              <Callout tone="key" title="The hook cannot break your session">
                The statusline is the only path that writes. The hook reads the cache, makes no
                network request of any kind, injects nothing when every provider is unknown, and
                exits 0 whatever happens.
              </Callout>
            </>
          ),
        },
        {
          id: "from-source",
          title: "Contribute from source",
          body: (
            <>
              <P>Use the repository toolchain when you want to contribute.</P>
              <CodeBlock
                label="terminal"
                code={`git clone https://github.com/lucaswebsystems/openlimiter
cd openlimiter
pnpm install
pnpm build
pnpm typecheck
pnpm test
node packages/cli/dist/bin.js demo`}
              />
              <P>
                The build has to run before the type check, because each package resolves its
                neighbours through the declaration files the build produces.
              </P>
            </>
          ),
        },
        {
          id: "where-next",
          title: "Where next",
          body: (
            <>
              <Sub id="reading-order">A reasonable reading order</Sub>
              <Steps
                items={[
                  <>
                    <DocLink href="/docs/why-openlimiter">Why OpenLimiter</DocLink>{" "}
                    for the problem this solves.
                  </>,
                  <>
                    <DocLink href="/docs/providers">Supported providers</DocLink>{" "}
                    for what each connector reads and how fragile it is.
                  </>,
                  <>
                    <DocLink href="/docs/agent-context">Agent context</DocLink>{" "}
                    for exactly what reaches your agent.
                  </>,
                  <>
                    <DocLink href="/docs/cli">CLI reference</DocLink>{" "}
                    for every command and exit code.
                  </>,
                ]}
              />
            </>
          ),
        },
      ]}
    />
  );
}
