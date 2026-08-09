import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import {
  Bullets,
  Callout,
  Code,
  DocLink,
  ExternalLink,
  P,
  Sub,
} from "@/components/docs/prose";
import { findDocPage } from "@/lib/docs";
import { REPO_URL } from "@/lib/site";

const page = findDocPage("/docs/security");

export const metadata: Metadata = {
  title: page?.title,
  description: page?.description,
  alternates: { canonical: "/docs/security" },
};

export default function SecurityPage() {
  return (
    <DocArticle
      href="/docs/security"
      title="Security and privacy"
      lead="OpenLimiter runs on your machine and reads things that are already there. This page states what that guarantees, what it deliberately does not do, and how to report a problem."
      sections={[
        {
          id: "guarantees",
          title: "The guarantees",
          body: (
            <>
              <Callout tone="key" title="What OpenLimiter guarantees">
                <Bullets
                  items={[
                    <>
                      <strong className="font-medium">There is no OpenLimiter server.</strong>{" "}
                      Nothing is sent to the project authors, because there is nowhere to send it.
                    </>,
                    <>
                      <strong className="font-medium">There is no telemetry.</strong> No command
                      sends usage, diagnostics, identifiers, prompts, or quota state anywhere.
                    </>,
                    <>
                      <strong className="font-medium">The hook makes no network request.</strong>{" "}
                      It reads the local cache and nothing else.
                    </>,
                    <>
                      <strong className="font-medium">This release performs no egress at all.</strong>{" "}
                      No connector contacts a provider. Every one of them is a parser over data
                      something else already produced.
                    </>,
                    <>
                      <strong className="font-medium">Unknown never becomes zero.</strong> Missing,
                      expired, malformed, and unrecognised input all resolve to unknown.
                    </>,
                    <>
                      <strong className="font-medium">
                        Provider authentication artifacts are read only.
                      </strong>{" "}
                      They are never rewritten, backed up, repaired, or migrated.
                    </>,
                  ]}
                />
              </Callout>
            </>
          ),
        },
        {
          id: "injection-boundary",
          title: "The agent context boundary",
          body: (
            <>
              <P>
                Provider text is untrusted data. A block injected into a prompt is an injection
                surface, so the pipeline is built so that no provider supplied text can reach it.
              </P>
              <Bullets
                items={[
                  <>
                    Connector parsers select known numeric fields and known timestamps. They discard
                    labels, messages, account text, markup, and every unknown field.
                  </>,
                  <>
                    The advice engine emits only provider enum codes, reason enum codes, bounded
                    percentages, freshness enum codes, and timestamps.
                  </>,
                  <>
                    The Claude Code adapter validates all of those again and wraps them in an
                    explicit untrusted data boundary before anything is written.
                  </>,
                  <>If every provider is unknown, the adapter injects nothing.</>,
                ]}
              />
              <P>
                The exact block, field by field, is on the{" "}
                <DocLink href="/docs/agent-context">agent context page</DocLink>.
              </P>
            </>
          ),
        },
        {
          id: "secrets",
          title: "Secret handling",
          body: (
            <>
              <P>
                The only credential the project has a concept of is an OpenRouter key, and it
                belongs in your operating system credential store. It must never appear in
                repository files, cache files, exports, diagnostics, fixtures, or logs. The
                credential library call sits behind an interface, and the tests use only a memory
                implementation with a synthetic key.
              </P>
              <Sub id="local-state">Local state</Sub>
              <P>
                The state directory is created with restrictive permissions where the platform
                supports them, a path that turns out to be a symbolic link is rejected rather than
                followed, and every file replacement is atomic. See{" "}
                <DocLink href="/docs/configuration">configuration</DocLink> for the paths.
              </P>
            </>
          ),
        },
        {
          id: "honest-limits",
          title: "Honest limitations",
          body: (
            <>
              <Callout tone="note" title="Read this before you rely on a number">
                <Bullets
                  items={[
                    <>
                      Most consumer subscription providers offer no official quota API. Several
                      connectors therefore describe unofficial interfaces that can change or
                      disappear without notice.
                    </>,
                    <>
                      Every connector ships marked <Code>UNVERIFIED</Code>. Nothing here has been
                      confirmed against a live account by an explicit verifier.
                    </>,
                    <>
                      The OpenCode connector describes an authenticated page shape and carries high
                      automation risk. Treat it as the most fragile of the six.
                    </>,
                    <>
                      OpenLimiter provides routing advice. It does not route requests
                      automatically, bypass limits, or change how your agent authenticates.
                    </>,
                  ]}
                />
              </Callout>
            </>
          ),
        },
        {
          id: "future-egress",
          title: "If a future connector goes to the network",
          body: (
            <>
              <P>
                This release performs no provider egress. A future connector that does would have
                to satisfy all of the following before it could ship.
              </P>
              <Bullets
                items={[
                  <>Declare one exact provider host.</>,
                  <>Use secure transport and reject any redirect outside that host.</>,
                  <>Set a short timeout and bound the response size.</>,
                  <>Document its interface status honestly.</>,
                  <>
                    Send no cache content, no other provider state, no prompts, no source code, and
                    no diagnostics.
                  </>,
                ]}
              />
            </>
          ),
        },
        {
          id: "reporting",
          title: "Reporting a problem",
          body: (
            <>
              <P>
                Report a suspected vulnerability privately to{" "}
                <Code>security@openlimiter.com</Code>. Include a concise description, the affected
                version, reproduction steps using synthetic data, and the expected impact. Do not
                include real credentials or provider account data. That address is a project
                placeholder until the public security intake is activated.
              </P>
              <P>
                In scope: secret disclosure, provider artifact mutation, unsafe cache behaviour,
                symbolic link bypass, parser bounds bypass, agent context injection, and unexpected
                network egress. Connector drift with no security impact is a compatibility issue,
                so please open a connector request instead. The full policy lives in{" "}
                <ExternalLink href={`${REPO_URL}/blob/main/SECURITY.md`}>SECURITY.md</ExternalLink>{" "}
                and the reasoning in{" "}
                <ExternalLink href={`${REPO_URL}/blob/main/THREAT_MODEL.md`}>
                  THREAT_MODEL.md
                </ExternalLink>
                .
              </P>
              <P>
                Only the latest released version receives security fixes during the initial
                development period.
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
