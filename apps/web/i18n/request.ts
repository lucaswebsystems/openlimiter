import { hasLocale } from "next-intl";
import { getRequestConfig } from "next-intl/server";
import { routing } from "./routing";

/**
 * What a request is told about its language.
 *
 * `requestLocale` is the `[locale]` segment when the route has one. The three
 * trees that sit outside it, the web application, the console and the blog, have
 * no segment to read, so they land on the default and get the English catalog.
 * That is deliberate: those surfaces stay English and still render the shared
 * chrome, and the chrome reads its labels from a catalog like everything else.
 *
 * The catalog is imported, not fetched. It is a build time module, so a locale's
 * messages are compiled into that locale's prerendered pages and no page ever
 * waits on a network round trip to know what it says.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale;
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale;

  return {
    locale,
    messages: (await import(`../messages/${locale}.json`)).default,
  };
});
