import NextLink from "next/link";
import type { ReactNode } from "react";
import { Link as IntlLink } from "@/i18n/navigation";
import { isUnlocalisedRoute } from "@/i18n/routing";

/**
 * The one internal link on this site.
 *
 * Since the site is published in five languages, an internal link has three
 * possible right answers and only one of them is `next/link`:
 *
 *   `/docs/cli` is localised, so on a Portuguese page it has to render
 *   `/pt-BR/docs/cli`. That is next-intl's `Link`.
 *
 *   `/app` and `/blog` are English only trees living outside `app/[locale]`, so
 *   a prefix in front of them is a 404. Those are plain `next/link`.
 *
 *   `#pricing` on the page you are already on is not a route at all.
 *
 * Every one of those was a bug waiting to be written at a call site. Here it is
 * one decision, made once, from the same list the middleware reads. A page
 * linking somewhere on this site uses this and does not think about locales.
 *
 * An address off this site keeps its own `<a>` at the call site, with its target
 * and its `rel`, because those are decisions about the destination rather than
 * about routing.
 */

export interface SiteLinkProps {
  /** Always the unprefixed English route, or a bare fragment. */
  href: string;
  className?: string;
  "aria-label"?: string;
  "aria-current"?: "page" | "true" | undefined;
  title?: string;
  id?: string;
  /** For the sheet, which closes itself on the way out. */
  onClick?: () => void;
  children: ReactNode;
}

export function SiteLink({ href, children, ...rest }: SiteLinkProps) {
  /* A fragment stays a fragment. Handing `#pricing` to a locale aware link would
     have it resolve against the route and produce `/pt-BR#pricing`, which is the
     home page rather than this spot on this page. */
  if (href.startsWith("#")) {
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  }

  if (isUnlocalisedRoute(href)) {
    return (
      <NextLink href={href} {...rest}>
        {children}
      </NextLink>
    );
  }

  return (
    <IntlLink href={href} {...rest}>
      {children}
    </IntlLink>
  );
}
