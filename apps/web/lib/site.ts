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

export const SPONSORS_URL = "https://github.com/sponsors/lucaswebsystems";

/**
 * Placeholder. The Buy Me a Coffee account may not exist yet, so treat this
 * link as unconfirmed until the page has been claimed.
 */
export const COFFEE_URL = "https://buymeacoffee.com/lucaswebsystems";

export const AUTHOR_NAME = "Lucas Costa";
export const AUTHOR_EMAIL = "lucas@lucaswebsystems.com";
export const AUTHOR_SITE = "https://lucaswebsystems.com";
export const AUTHOR_GITHUB = "https://github.com/lucaswebsystems";
export const AUTHOR_LINKEDIN = "https://www.linkedin.com/in/lucas-costa-t/";

/**
 * THE HERO BACKDROP OFF SWITCH.
 *
 * The one flag that controls the video behind the hero. Set it to `false` and
 * the hero returns to exactly the look it had before the experiment: the
 * component is never rendered, so no video element, no poster and no veil reach
 * the page, and the hero section does not even take the class that would give
 * them somewhere to sit. There is nothing else to undo and no second place to
 * look.
 *
 * Typed as `boolean` rather than left to infer the literal, so both branches
 * stay type checked and flipping this value can never turn the other one into
 * dead code the compiler has already discarded.
 *
 * See components/hero-backdrop.tsx for what it switches on.
 */
export const HERO_BACKDROP_ENABLED: boolean = true;

/** The version this site describes. Kept in step with the root CHANGELOG. */
export const CURRENT_VERSION = "0.1.0";

/**
 * What actually ships today, in one place, so no surface can quietly promote a
 * plan into a product. Every download row, every roadmap card and every status
 * chip on the site reads its wording from this vocabulary.
 */
export type ShipState = "available" | "in development" | "planned";
