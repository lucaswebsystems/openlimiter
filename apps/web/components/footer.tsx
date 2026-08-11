import { useTranslations } from "next-intl";
import { BrandLockup } from "./brand";
import { LocaleSwitcher } from "./locale-switcher";
import { GitHubMark, SHELL } from "./ui";
import { SiteLink } from "./site-link";
import { reveal } from "@/lib/motion";
import {
  AUTHOR_EMAIL,
  AUTHOR_GITHUB,
  AUTHOR_LINKEDIN,
  AUTHOR_SITE,
  COFFEE_URL,
  ISSUES_URL,
  LICENSE_URL,
  REPO_URL,
  SPONSORS_URL,
} from "@/lib/site";

/**
 * The footer.
 *
 * Five columns: the brand, product links, resources, contact details, and the
 * language switcher. Every link points at something that exists.
 *
 * There is no Discord link anywhere on this site, by instruction.
 *
 * THE LANGUAGE SWITCHER LIVES HERE
 * --------------------------------
 * The fifth column of every page that has translations. A reader looking for
 * their language looks at the foot of the page, and a control in the header
 * would be a sixth thing competing with the product's own navigation.
 * The three English only trees render this footer with `localised` off, because
 * a switcher there would point at pages that do not exist.
 */

interface FooterLink {
  label: string;
  href: string;
  external?: boolean;
}

/*
  The link rows.

  Each row is a flex line rather than a block, so the chevron and the label are
  one object: the glyph is 12 pixels, sits on the text baseline box, and slides
  two pixels to the right under a pointer, which is the same two pixel gesture
  the cards on this site make. `leading-5` pulls the lists a step tighter than
  the surrounding text, which is what makes a column read as a list rather than
  as loose paragraphs.
*/
const linkClass =
  "focus-ring group inline-flex items-center gap-1 rounded py-0.5 leading-5 text-muted transition-colors duration-200 hover:text-heading";

const contactClass =
  "focus-ring inline-flex items-center gap-2 rounded text-muted transition-colors duration-200 hover:text-heading";

function LinkChevron() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-3 w-3 flex-none text-muted transition-[color,transform] duration-200 group-hover:translate-x-0.5 group-hover:text-accent"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m9 5 7 7-7 7" />
    </svg>
  );
}

function Column({ title, links }: { title: string; links: readonly FooterLink[] }) {
  return (
    <div className="grid grid-rows-[2rem_auto] gap-3" {...reveal}>
      <p className="heading-face flex h-8 items-center justify-center text-heading md:justify-start">
        {title}
      </p>
      <div className="flex flex-col items-center gap-0.5 md:items-start">
        {links.map((link) =>
          link.external === true ? (
            <a
              key={`${link.label}-${link.href}`}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className={linkClass}
            >
              <LinkChevron />
              {link.label}
            </a>
          ) : (
            <SiteLink key={`${link.label}-${link.href}`} href={link.href} className={linkClass}>
              <LinkChevron />
              {link.label}
            </SiteLink>
          ),
        )}
      </div>
    </div>
  );
}

function LinkedInMark({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg className={`${className} fill-current`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.98 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3 9h4v12H3V9Zm6.5 0h3.8v1.64h.05c.53-.95 1.83-1.95 3.76-1.95 4.02 0 4.76 2.5 4.76 5.76V21h-4v-5.66c0-1.35-.03-3.09-1.94-3.09-1.94 0-2.24 1.47-2.24 2.99V21h-3.99V9Z" />
    </svg>
  );
}

function GlobeMark({ className = "h-4 w-4" }: { className?: string }) {
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
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a15 15 0 0 1 0 18a15 15 0 0 1 0-18Z" />
    </svg>
  );
}

function MailMark({ className = "h-4 w-4" }: { className?: string }) {
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
      <rect x="2.75" y="4.75" width="18.5" height="14.5" rx="2.5" />
      <path d="m3.5 7.5 7.4 5.1a2 2 0 0 0 2.2 0l7.4-5.1" />
    </svg>
  );
}

function ContactColumn() {
  return (
    <div className="grid grid-rows-[2rem_auto] gap-3" {...reveal}>
      <p className="heading-face flex h-8 items-center justify-center text-heading md:justify-start">
        Contact
      </p>
      <div className="flex flex-col items-center gap-2 md:items-start">
        <a
          href={AUTHOR_SITE}
          target="_blank"
          rel="noopener noreferrer"
          className={contactClass}
        >
          <GlobeMark />
          lucaswebsystems.com
        </a>
        <a href={`mailto:${AUTHOR_EMAIL}`} className={contactClass}>
          <MailMark />
          {AUTHOR_EMAIL}
        </a>
        <a
          href={AUTHOR_GITHUB}
          target="_blank"
          rel="noopener noreferrer"
          className={contactClass}
        >
          <GitHubMark />
          GitHub
        </a>
        <a
          href={AUTHOR_LINKEDIN}
          target="_blank"
          rel="noopener noreferrer"
          className={contactClass}
        >
          <LinkedInMark />
          LinkedIn
        </a>
      </div>
    </div>
  );
}

function LanguageColumn({ title }: { title: string }) {
  return (
    <div className="grid grid-rows-[2rem_auto] gap-3" {...reveal}>
      <p className="heading-face flex h-8 items-center justify-center text-heading md:justify-start">
        {title}
      </p>
      <LocaleSwitcher vertical />
    </div>
  );
}

export function Footer({ localised = true }: { localised?: boolean }) {
  const t = useTranslations("footer");
  const terms = useTranslations("terms");
  const localeSwitcher = useTranslations("localeSwitcher");
  const routes = useTranslations("common.routes");
  const common = useTranslations("common");

  /* Five and six links, an even read (founder's order, 2026-08-11): the
     licence moved into the bottom bar beside the copyright, where he put it. */
  const product: FooterLink[] = [
    { label: routes("webApp"), href: "/app" },
    { label: routes("download"), href: "/download" },
    { label: routes("changelog"), href: "/changelog" },
    { label: routes("docs"), href: "/docs" },
    { label: routes("blog"), href: "/blog" },
  ];

  const resources: FooterLink[] = [
    { label: "GitHub", href: REPO_URL, external: true },
    { label: t("issues"), href: ISSUES_URL, external: true },
    { label: "GitHub Sponsors", href: SPONSORS_URL, external: true },
    { label: "Buy me a coffee", href: COFFEE_URL, external: true },
    { label: t("security"), href: "/docs/security" },
  ];

  return (
    /* The bottom padding is generous on a phone because the back to top button
       is fixed in that corner, and the licence line is centred, so a tight
       footer put a floating circle on top of the last sentence of the page.
       The button is 44 pixels tall and sits 20 from the edge, so 96 clears it
       with room left over. Wide screens never had the collision. */
    <footer className={`${SHELL} pb-24 pt-4 text-center sm:pb-8 md:pb-16 md:text-left`}>
      <div className="grid gap-8 border-t border-hairline pt-10 text-sm lg:grid-cols-[minmax(0,18rem)_minmax(0,0.75fr)_minmax(0,0.85fr)_minmax(0,1.4fr)_minmax(0,1fr)]">
        <div className="mx-auto grid w-full max-w-[18rem] grid-rows-[2rem_auto] gap-3 md:mx-0" {...reveal}>
          <SiteLink
            href="/"
            aria-label={common("homeAria")}
            className="focus-ring inline-flex h-8 items-center justify-center rounded md:justify-start"
          >
            <BrandLockup
              markClassName="h-8 w-8 flex-none text-brand"
              wordClassName="text-xl"
            />
          </SiteLink>
          <p className="leading-relaxed text-muted">{t("blurb")}</p>
        </div>

        <Column title={t("product")} links={product} />
        <Column title={t("resources")} links={resources} />
        <ContactColumn />
        {localised && <LanguageColumn title={localeSwitcher("label")} />}
      </div>

      <div
        className="mt-10 grid items-center gap-3 border-t border-hairline py-6 text-center md:grid-cols-[minmax(0,1fr)_auto] md:text-left"
        {...reveal}
      >
        <p className="text-xs leading-relaxed text-muted">
          © {new Date().getFullYear()} OpenLimiter.com
          <span className="legal-dot" aria-hidden="true" />
          {t("rights")}
          <span className="legal-dot" aria-hidden="true" />
          <a
            href={LICENSE_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
          >
            {t("licensed")}
          </a>
          <span className="legal-dot" aria-hidden="true" />
          <SiteLink
            href="/terms"
            className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
          >
            {terms("title")}
          </SiteLink>
        </p>
        <p className="justify-self-center text-xs leading-relaxed text-muted md:justify-self-end">
          {t("builtBy")}{" "}
          <a
            href={AUTHOR_SITE}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
          >
            Lucas Costa
          </a>
        </p>
      </div>
    </footer>
  );
}
