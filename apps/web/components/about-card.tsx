import { BrandMark } from "./brand";
import { ButtonLink, GitHubMark } from "./ui";
import { reveal } from "@/lib/motion";
import { AUTHOR_EMAIL, AUTHOR_NAME, REPO_URL, SPONSORS_URL } from "@/lib/site";

/**
 * The closing note.
 *
 * It used to be a 576 pixel box floating in a much wider column, which is what
 * happens when a reference's proportions are copied without its content. This
 * one runs the full width of the section and earns it: the claim the project is
 * built on is set large on the left, the three commitments underneath it are
 * separated so each can be read on its own, and the signature is a real block
 * with a name, a role and a way to reach him rather than a line of grey text.
 *
 * Nothing here claims a user, a number or an endorsement, because there are
 * none to claim.
 */

const commitments = [
  {
    title: "It runs on your machine",
    detail:
      "Every connector in this release is a parser over something already on your disk. No provider egress, no daemon, no account.",
  },
  {
    title: "It reports to nobody",
    detail:
      "The software has no telemetry, no analytics, and no OpenLimiter server for anything to reach. This website keeps cookieless page counts only, with no cookies and nothing personal.",
  },
  {
    title: "Unknown stays unknown",
    detail:
      "A missing number never becomes a confident one. When a shape changes underneath a connector, that provider fails closed.",
  },
];

export function AboutCard() {
  return (
    <div
      className="overflow-hidden rounded-2xl border border-hairline bg-raised p-8 md:p-12"
      {...reveal}
    >
      <div className="grid gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
        <div className="space-y-5">
          <BrandMark className="h-9 w-9 text-brand" />
          <p className="text-xl leading-relaxed text-heading md:text-2xl">
            OpenLimiter is an independent open source project for people who hold several AI coding
            subscriptions at once and would rather know which one still has room than find out the
            hard way, mid task.
          </p>
          <p className="max-w-xl text-sm leading-relaxed text-muted">
            It is built around three commitments that are easy to state and awkward to keep. If it
            saves you an afternoon, sponsorship is the best way to keep the connectors working as
            the shapes underneath them shift. Reporting a connector that broke is worth just as
            much.
          </p>
        </div>

        <div className="space-y-5">
          {commitments.map((item) => (
            <div key={item.title} className="border-l border-hairline-strong pl-4">
              <p className="text-sm font-medium text-heading">{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{item.detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-6 border-t border-hairline pt-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-base font-medium text-heading">{AUTHOR_NAME}</p>
          <p className="mt-1 text-sm text-muted">
            Author and maintainer.{" "}
            <a
              href={`mailto:${AUTHOR_EMAIL}`}
              className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
            >
              {AUTHOR_EMAIL}
            </a>
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href={SPONSORS_URL} external>
            Sponsor the project
          </ButtonLink>
          <ButtonLink href={REPO_URL} external>
            <GitHubMark className="h-4 w-4" />
            Read the source
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
