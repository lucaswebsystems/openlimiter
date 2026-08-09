import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Steps, Sub } from "@/components/docs/prose";
import { findDocPage } from "@/lib/docs";

const page = findDocPage("/docs");

export const metadata: Metadata = {
  title: page?.title,
  description: page?.description,
  alternates: { canonical: "/docs" },
};

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
                  <>Node 24 or newer, which the workspace declares in its engines field.</>,
                  <>pnpm 9.15.0, the package manager the repository pins.</>,
                  <>
                    A git clone of the repository. OpenLimiter is not published to npm yet, so
                    there is no global <Code>openlimiter</Code> command to install.
                  </>,
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
          title: "Install the workspace",
          body: (
            <>
              <P>Run these in order on a clean clone.</P>
              <CodeBlock
                label="terminal"
                code={`pnpm install
pnpm build
pnpm typecheck
pnpm test
pnpm openlimiter demo`}
              />
              <P>
                The build has to run before the type check, because each package resolves its
                neighbours through the declaration files the build produces.
              </P>
              <P>
                <Code>pnpm openlimiter</Code> is a thin wrapper around the built entry point.
                Anywhere these pages write <Code>openlimiter &lt;command&gt;</Code>, you can run
                either of these from the repository root.
              </P>
              <CodeBlock
                code={`pnpm openlimiter <command>
node packages/cli/dist/bin.js <command>`}
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
                code={`node packages/cli/dist/bin.js statusline < session.json
OpenLimiter NEAR_CAP CLAUDE 87.5% UNKNOWN OPENROUTER,CODEX,ANTIGRAVITY,OPENCODE,MANUAL`}
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
                Add this to your Claude Code <Code>settings.json</Code>, using the absolute path to
                your clone. Forward slashes work on every platform.
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
              <Callout tone="key" title="The hook cannot break your session">
                The statusline is the only path that writes. The hook reads the cache, makes no
                network request of any kind, injects nothing when every provider is unknown, and
                exits 0 whatever happens.
              </Callout>
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
