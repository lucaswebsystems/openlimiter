import { ButtonLink, GitHubMark } from "./ui";
import { AUTHOR_NAME, REPO_URL, SPONSORS_URL } from "@/lib/site";

/**
 * The closing note.
 *
 * 576 pixels wide, the same narrow measure the reference uses for its own
 * closing card. Signed, because someone should put their name to the claims on
 * a page like this one.
 */
export function AboutCard() {
  return (
    <div className="max-w-xl space-y-4 rounded-xl border border-hairline bg-raised p-8 text-left md:p-10">
      <div className="space-y-3 text-sm leading-relaxed text-muted">
        <p>
          OpenLimiter is an independent open source project for people who hold several AI coding
          subscriptions at once and would rather know which one still has room than find out the
          hard way, mid task.
        </p>
        <p>
          It is built around three commitments that are easy to state and awkward to keep: it runs
          on your machine, it reports to nobody, and it never turns a missing number into a
          confident one. Unknown stays unknown.
        </p>
        <p>
          If it saves you an afternoon, sponsorship is the best way to keep the connectors working
          as the shapes underneath them shift. Reporting a connector that broke is worth just as
          much.
        </p>
        <p className="text-heading">{AUTHOR_NAME}</p>
      </div>
      <div className="flex flex-wrap gap-3 pt-2">
        <ButtonLink href={SPONSORS_URL} external>
          Sponsor the project
        </ButtonLink>
        <ButtonLink href={REPO_URL} external>
          <GitHubMark className="h-4 w-4" />
          Read the source
        </ButtonLink>
      </div>
    </div>
  );
}
