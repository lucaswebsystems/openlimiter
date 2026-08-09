import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, DocLink, P, Sub } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";

export const metadata: Metadata = docMetadata("/docs/why-openlimiter");

export default function WhyPage() {
  return (
    <DocArticle
      href="/docs/why-openlimiter"
      title="Why OpenLimiter"
      lead="When you hold several AI coding subscriptions, the scarce resource stops being money and becomes quota. You already paid. The question that decides your afternoon is which of those plans still has room left."
      sections={[
        {
          id: "the-problem",
          title: "The problem",
          body: (
            <>
              <P>
                A developer running two or three coding agents ends the week with the same
                recurring interruption. One plan hits its window, the agent stops mid task, and the
                work pauses while a human goes hunting through dashboards to find out which other
                subscription is still usable.
              </P>
              <P>
                The information exists. It is scattered across a statusline payload, a local usage
                file, a billing page, and a credit balance, in four different shapes, none of which
                the agent can see.
              </P>
            </>
          ),
        },
        {
          id: "what-it-does",
          title: "What OpenLimiter does about it",
          body: (
            <>
              <P>
                OpenLimiter reads quota for supported AI subscriptions on your own machine,
                normalises every reading into one schema, and feeds bounded budget state plus
                routing advice into the coding agents&apos; own context. The first adapter is a
                Claude Code statusline and prompt hook.
              </P>
              <Bullets
                items={[
                  <>
                    <strong className="font-medium text-heading">Read.</strong> Connectors parse
                    shapes that a provider or a local tool already produced. They perform no
                    network access in this release.
                  </>,
                  <>
                    <strong className="font-medium text-heading">Normalise.</strong> One snapshot
                    schema with closed enums, bounded percentages, and derived freshness. Unknown
                    stays unknown and never becomes a fabricated zero.
                  </>,
                  <>
                    <strong className="font-medium text-heading">Advise.</strong> A compact
                    statusline for you, and a bounded context block for your agent that carries
                    enum codes, numbers, and timestamps only.
                  </>,
                ]}
              />
            </>
          ),
        },
        {
          id: "what-it-is-not",
          title: "What it deliberately is not",
          body: (
            <>
              <Callout tone="key" title="Advice, never automatic routing">
                OpenLimiter provides routing advice. It does not route requests for you, it does
                not bypass a limit, and it never mutates a provider&apos;s authentication
                artifacts. The decision stays with you and your agent.
              </Callout>
              <Bullets
                items={[
                  <>It is not a proxy. Your requests keep going straight to your provider.</>,
                  <>
                    It is not a dashboard service. There is no OpenLimiter server, no account, and
                    no telemetry.
                  </>,
                  <>
                    It is not a billing tool. It reports how much of a window you have consumed,
                    not what you will be charged.
                  </>,
                ]}
              />
            </>
          ),
        },
        {
          id: "design-rules",
          title: "The rules the code follows",
          body: (
            <>
              <Sub id="unknown-stays-unknown">Unknown stays unknown</Sub>
              <P>
                Missing, expired, malformed, and unrecognised input all resolve to unknown. A
                connector that cannot read something says so. Nothing in the codebase turns an
                absent reading into a zero, because a fake zero would make an agent behave as
                though a plan were exhausted.
              </P>
              <Sub id="truncated-not-rounded">Percentages are truncated, never rounded up</Sub>
              <P>
                A meter at 99.99 percent renders as 99.9 percent. A cap is only ever claimed once
                it has actually been reached.
              </P>
              <Sub id="one-bad-row">One bad row does not lose a provider</Sub>
              <P>
                A row that fails validation is dropped and the remaining rows still count. One
                expired window is not a reason to forget a whole subscription.
              </P>
              <Sub id="local-first">Local first, with no server to trust</Sub>
              <P>
                Everything is written to a local state directory under your own user account.
                See <DocLink href="/docs/configuration">configuration</DocLink> for where that is,
                and <DocLink href="/docs/security">security and privacy</DocLink> for what that
                buys you. The licence is Apache 2.0 and the whole thing is <Code>UNVERIFIED</Code>{" "}
                by its own labels until a verifier exists.
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
