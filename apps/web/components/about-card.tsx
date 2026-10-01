import { useTranslations } from "next-intl";
import { BrandLockup } from "./brand";
import { ButtonLink, GitHubMark } from "./ui";
import { reveal } from "@/lib/motion";
import { AUTHOR_EMAIL, AUTHOR_NAME, COFFEE_URL, REPO_URL, SPONSORS_URL } from "@/lib/site";

/** A cup, for the second of the two support links. Drawn here, no brand mark. */
function CoffeeMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.75 8.75h13v6a4.5 4.5 0 0 1-4.5 4.5h-4a4.5 4.5 0 0 1-4.5-4.5Z" />
      <path d="M16.75 10.25h1.75a2.5 2.5 0 0 1 0 5h-1.75" />
      <path d="M7 3v2.25M10.25 3v2.25M13.5 3v2.25" />
    </svg>
  );
}

/** GitHub Sponsors, a heart. */
function HeartMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 20.25S3.75 15.5 3.75 9.6A4.35 4.35 0 0 1 12 7.35 4.35 4.35 0 0 1 20.25 9.6c0 5.9-8.25 10.65-8.25 10.65Z" />
    </svg>
  );
}

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

/** One stable slug per commitment, keyed rather than indexed, matching the catalog. */
const commitmentSlugs = ["runsLocal", "reportsNobody", "unknownStaysUnknown"] as const;

export function AboutCard() {
  const t = useTranslations("about");
  const commitments = commitmentSlugs.map((slug) => ({
    slug,
    title: t(`commitments.${slug}.title`),
    detail: t(`commitments.${slug}.detail`),
  }));
  return (
    <div
      className="overflow-hidden rounded-2xl border border-hairline bg-raised p-8 md:p-12"
      {...reveal}
    >
      <div className="grid gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-16">
        <div className="space-y-5">
          <BrandLockup markClassName="h-8 w-8 flex-none text-brand" wordClassName="text-xl" />
          <p className="text-xl leading-relaxed text-heading md:text-2xl">{t("lead")}</p>
          <p className="max-w-xl text-sm leading-relaxed text-muted">{t("description")}</p>
        </div>

        <div className="space-y-5">
          {commitments.map((item) => (
            <div key={item.slug} className="border-l border-hairline-strong pl-4">
              <p className="heading-face text-sm text-heading">{item.title}</p>
              <p className="mt-1 text-sm leading-relaxed text-muted">{item.detail}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10 flex flex-col gap-6 border-t border-hairline pt-8 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="heading-face text-base text-heading">{AUTHOR_NAME}</p>
          <p className="mt-1 text-sm text-muted">
            {t("signature.role")}{" "}
            <a
              href={`mailto:${AUTHOR_EMAIL}`}
              className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
            >
              {AUTHOR_EMAIL}
            </a>
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <ButtonLink href={SPONSORS_URL} tone="primary" external>
            <HeartMark />
            GitHub Sponsors
          </ButtonLink>
          <ButtonLink href={COFFEE_URL} external>
            <CoffeeMark />
            Buy me a coffee
          </ButtonLink>
          <ButtonLink href={REPO_URL} external>
            <GitHubMark className="h-4 w-4" />
            {t("readSource")}
          </ButtonLink>
        </div>
      </div>
    </div>
  );
}
