import { createNavigation } from "next-intl/navigation";
import { routing } from "./routing";

/**
 * Locale aware navigation.
 *
 * These are drop in replacements for the same names from `next/link` and
 * `next/navigation`, and they know the prefix rule: a `<Link href="/docs">` on a
 * Portuguese page renders `/pt-BR/docs`, and the same link on an English page
 * renders `/docs`. Written by hand, that rule would have to be repeated at every
 * link on the site and would be wrong at one of them.
 *
 * `usePathname` is the other half of it, and the reason the footer switcher can
 * exist: it reports the pathname with the locale stripped off, so a control that
 * wants "this same page, in another language" has something to build from.
 */
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
