import { ScrollReveal } from "./scroll-reveal";
import { ButtonLink, GitHubMark } from "./ui";
import { REPO_URL } from "@/lib/site";

export function FinalCta() {
  return (
    <section className="border-t border-hairline px-4 py-24 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <ScrollReveal>
          <div className="max-w-2xl">
            <h2 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
              Give your agents budget sense.
            </h2>
            <p className="mt-3 font-sans text-sm leading-relaxed text-body">
              Clone the repository, run the demo, and wire the statusline in a few minutes. It is
              not published to npm yet, so the docs start from a git clone.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <ButtonLink href="/docs" tone="primary">
                Get started
              </ButtonLink>
              <ButtonLink href={REPO_URL} tone="secondary" external>
                <GitHubMark className="h-4 w-4" />
                View on GitHub
              </ButtonLink>
            </div>
          </div>
        </ScrollReveal>
      </div>
    </section>
  );
}
