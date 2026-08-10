/**
 * Facts about the project that more than one surface needs.
 *
 * Everything here is verifiable: the repository, the licence, the author, and
 * the two ways to support the work. Nothing in this file is a claim about
 * users, revenue, or adoption.
 */

export const SITE_URL = "https://openlimiter.com";

/** The project's name, as a publisher, an organisation and a social site name. */
export const SITE_NAME = "OpenLimiter";

/**
 * The one title and the one description every surface starts from: the root
 * metadata, the social cards, and the structured data. Written once so a schema
 * can never describe the site differently from the tag next to it.
 */
export const SITE_TITLE = "OpenLimiter, quota awareness for AI coding agents";
export const SITE_DESCRIPTION =
  "OpenLimiter reads the quota of your AI subscriptions on your own machine and hands your coding agents bounded budget state plus routing advice. Open source, local first, zero telemetry.";

/**
 * What the title template appends to a page's own title. Kept here so a social
 * title can be made to match the rendered title tag exactly, rather than being
 * typed out a second time next to it.
 */
export const TITLE_SUFFIX = ", OpenLimiter";

export const REPO_OWNER = "lucaswebsystems";
export const REPO_NAME = "openlimiter";
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;
export const RELEASES_URL = `${REPO_URL}/releases`;
/** Where a reader gets the packaged Windows build. */
export const RELEASES_LATEST_URL = `${REPO_URL}/releases/latest`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

/** The licence itself, by name and by the canonical text of the licence. */
export const LICENSE_NAME = "Apache 2.0";
export const LICENSE_SPDX_URL = "https://www.apache.org/licenses/LICENSE-2.0";

/** The published command line package. */
export const NPM_PACKAGE = "openlimiter";
export const NPM_URL = `https://www.npmjs.com/package/${NPM_PACKAGE}`;

/**
 * A square logo that lives at a fixed path, unlike the generated icon routes,
 * which is what structured data and any third party card needs. It is the same
 * file the installed web application already ships.
 */
export const LOGO_URL = `${SITE_URL}/icons/openlimiter-512.png`;
export const LOGO_SIZE = 512;
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;
export const SECURITY_URL = `${REPO_URL}/blob/main/SECURITY.md`;

/**
 * The two ways to support the work, both live and both claimed. Sponsorship is
 * the only money anywhere near this project: there is no checkout, no paid
 * tier, and no local feature held back to create one.
 */
export const SPONSORS_URL = "https://github.com/sponsors/lucaswebsystems";
export const COFFEE_URL = "https://buymeacoffee.com/lucaswebsystems";

/**
 * OpenLimiter Pro, and the exact words allowed around its two numbers.
 *
 * Pro is not built. It has never been sold, at any price, to anybody, and no
 * surface on this site may imply otherwise.
 *
 * `PRO_PRICE` is the founding price, the one an early supporter would pay.
 * `PRO_REGULAR_PRICE` is the **planned** regular price, and it is written in
 * the future tense wherever it appears, because it is a plan rather than a
 * price anything was ever charged at. It is never framed as a discount from a
 * former price, never given an end date, and never given a countdown, because
 * all three would be inventing a history the product does not have.
 *
 * The only sentence the regular price is allowed to appear in is
 * `PRO_PRICE_NOTE`, which is written once here and rendered once, on the
 * pricing card. Every other surface, the FAQ and the roadmap included, names
 * the founding price alone.
 */
export const PRO_PRICE = "$5";
export const PRO_REGULAR_PRICE = "$10";
export const PRO_PRICE_NOTE = "$10 is the planned regular price. Early supporters keep $5.";

export const AUTHOR_NAME = "Lucas Costa";
export const AUTHOR_EMAIL = "lucas@lucaswebsystems.com";
export const AUTHOR_SITE = "https://lucaswebsystems.com";
export const AUTHOR_GITHUB = "https://github.com/lucaswebsystems";
export const AUTHOR_LINKEDIN = "https://www.linkedin.com/in/lucas-costa-t/";

/**
 * THE FOLD FOOTAGE OFF SWITCH.
 *
 * The one flag that controls the footage inside the first fold. Set it to
 * `false` and the media component is never rendered, so no poster, no video
 * and no pause control reach the page; the fold itself stays what it now is,
 * the full height dark island with its scrims over the plain dark canvas,
 * because the fold's shape is the design rather than an experiment riding a
 * flag.
 *
 * Typed as `boolean` rather than left to infer the literal, so both branches
 * stay type checked and flipping this value can never turn the other one into
 * dead code the compiler has already discarded.
 *
 * See components/hero-backdrop.tsx for what it switches on.
 */
export const HERO_BACKDROP_ENABLED: boolean = true;

/** The version this site describes. Kept in step with the root CHANGELOG. */
export const CURRENT_VERSION = "0.3.0";

/**
 * What actually ships today, in one place, so no surface can quietly promote a
 * plan into a product. Every download row, every roadmap card and every status
 * chip on the site reads its wording from this vocabulary.
 */
export type ShipState = "available" | "in development" | "planned";
