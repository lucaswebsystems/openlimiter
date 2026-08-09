import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub, Table } from "@/components/docs/prose";
import { findDocPage } from "@/lib/docs";

const page = findDocPage("/docs/providers");

export const metadata: Metadata = {
  title: page?.title,
  description: page?.description,
  alternates: { canonical: "/docs/providers" },
};

export default function ProvidersPage() {
  return (
    <DocArticle
      href="/docs/providers"
      title="Supported providers"
      lead="Six connectors ship today. Each one carries its own honest labels describing where its credentials come from, how official its data interface is, and how likely it is to break."
      sections={[
        {
          id: "the-six",
          title: "The six connectors",
          body: (
            <>
              <Table
                caption="Connectors that ship today, with what each one reads and how stable it is"
                columns={[
                  { key: "id", header: "id" },
                  { key: "reads", header: "reads" },
                  { key: "status", header: "interface status" },
                ]}
                rows={[
                  {
                    id: <Code>claude</Code>,
                    reads: "The rate limit block of the Claude Code statusline payload",
                    status: "Native payload from a local tool. Low automation risk.",
                  },
                  {
                    id: <Code>openrouter</Code>,
                    reads: "A credits response shape from OpenRouter's documented API",
                    status: "Documented API. Low automation risk.",
                  },
                  {
                    id: <Code>codex</Code>,
                    reads: "A usage payload the Codex tooling produces",
                    status: "Internal endpoint. May break without notice.",
                  },
                  {
                    id: <Code>antigravity</Code>,
                    reads: "A quota payload the Antigravity tooling produces",
                    status: "Internal endpoint. May break without notice.",
                  },
                  {
                    id: <Code>opencode</Code>,
                    reads: "A usage view behind a session you already signed in to",
                    status: "Authenticated page. High automation risk. May break.",
                  },
                  {
                    id: <Code>manual</Code>,
                    reads: "Numbers you write yourself",
                    status: "Manual entry. Never breaks, never guesses.",
                  },
                ]}
              />
              <Callout tone="key" title="Every connector ships marked UNVERIFIED">
                <Code>UNVERIFIED</Code> is the honest default. It means no explicit verifier has
                confirmed the shape against a live account, so <Code>openlimiter doctor</Code>{" "}
                reports drift as unverified rather than claiming a connector is known good.
              </Callout>
            </>
          ),
        },
        {
          id: "how-data-arrives",
          title: "How data actually arrives",
          body: (
            <>
              <P>
                This is the part that surprises people, so it is worth stating plainly. In this
                release no connector performs network access. Every one of them is a parser, and
                something else has to hand it a document.
              </P>
              <Bullets
                items={[
                  <>
                    <Code>claude</Code> is fed by the statusline payload arriving on standard
                    input. That path is automatic once Claude Code is wired up.
                  </>,
                  <>
                    <Code>manual</Code> is fed by a document you place in the state directory.
                  </>,
                  <>
                    <Code>codex</Code>, <Code>antigravity</Code>, <Code>opencode</Code> and{" "}
                    <Code>openrouter</Code> have no local reader yet. They accept data through{" "}
                    <Code>openlimiter ingest --provider &lt;id&gt;</Code> and nothing else.
                  </>,
                ]}
              />
              <P>
                The <DocLink href="/docs/ingestion">ingestion page</DocLink> documents all three
                paths and the exact shapes they accept.
              </P>
            </>
          ),
        },
        {
          id: "labels",
          title: "Reading the labels",
          body: (
            <>
              <P>
                Every snapshot carries four labels, so a surface can always tell a reader how much
                to trust a number.
              </P>
              <Table
                caption="The four connector labels and their meaning"
                columns={[
                  { key: "label", header: "label" },
                  { key: "values", header: "values you will see" },
                ]}
                rows={[
                  {
                    label: <Code>credentialOrigin</Code>,
                    values: (
                      <>
                        <Code>official-local-tool</Code>, <Code>user-key</Code>,{" "}
                        <Code>browser-session</Code>, <Code>user-entered</Code>
                      </>
                    ),
                  },
                  {
                    label: <Code>dataInterfaceStatus</Code>,
                    values: (
                      <>
                        <Code>native-statusline-payload</Code>, <Code>documented-api</Code>,{" "}
                        <Code>internal-endpoint</Code>, <Code>authenticated-scrape</Code>,{" "}
                        <Code>manual</Code>
                      </>
                    ),
                  },
                  {
                    label: <Code>automationRisk</Code>,
                    values: (
                      <>
                        <Code>low</Code> or <Code>high</Code>
                      </>
                    ),
                  },
                  {
                    label: <Code>verification</Code>,
                    values: <Code>UNVERIFIED</Code>,
                  },
                ]}
              />
              <Sub id="drift">What drift looks like</Sub>
              <P>
                Unofficial interfaces change without notice. When a shape moves, parsing fails
                closed: the affected provider returns to unknown, the other providers are
                unaffected, and nothing invents a number to fill the gap.
              </P>
            </>
          ),
        },
        {
          id: "openrouter-key",
          title: "The OpenRouter credential",
          body: (
            <>
              <P>
                OpenRouter is the one connector that expects a key of your own. That key belongs in
                your operating system credential store and nowhere else. It must never appear in
                repository files, cache files, exports, diagnostics, fixtures, or logs.
              </P>
              <Callout tone="note" title="Stubbed in this release">
                The credential library adapter is deliberately stubbed, so{" "}
                <Code>openlimiter init</Code> cannot store a key until you supply a driver. Until
                then, feed OpenRouter through the ingest command like any other provider.
              </Callout>
              <CodeBlock
                label="terminal"
                code={`openlimiter ingest --provider openrouter --payload '{"data":{"total_credits":15,"total_usage":14.2}}'`}
              />
            </>
          ),
        },
        {
          id: "not-yet",
          title: "Connectors that do not exist yet",
          body: (
            <>
              <P>
                Only the six above are real. Anything else you might hope for is not built, is not
                scheduled, and should not be assumed. If a subscription has no connector, the
                manual path covers it today with numbers you enter yourself.
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
