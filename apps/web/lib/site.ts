/**
 * Facts about the project that more than one surface needs.
 *
 * Everything here is verifiable: the repository, the licence, the author, and
 * the two ways to support the work. Nothing in this file is a claim about
 * users, revenue, or adoption.
 */

export const SITE_URL = "https://openlimiter.com";
export const REPO_OWNER = "lucaswebsystems";
export const REPO_NAME = "openlimiter";
export const REPO_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}`;
export const ISSUES_URL = `${REPO_URL}/issues`;
export const DISCUSSIONS_URL = `${REPO_URL}/discussions`;
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;
export const CONTRIBUTING_URL = `${REPO_URL}/blob/main/CONTRIBUTING.md`;
export const SECURITY_URL = `${REPO_URL}/blob/main/SECURITY.md`;

export const SPONSORS_URL = "https://github.com/sponsors/lucaswebsystems";

/**
 * Placeholder. The Buy Me a Coffee account may not exist yet, so treat this
 * link as unconfirmed until the page has been claimed.
 */
export const COFFEE_URL = "https://buymeacoffee.com/lucaswebsystems";

export const AUTHOR_NAME = "Lucas Costa";
export const AUTHOR_SITE = "https://lucaswebsystems.com";
export const AUTHOR_GITHUB = "https://github.com/lucaswebsystems";
export const AUTHOR_LINKEDIN = "https://www.linkedin.com/in/lucas-costa-t/";

/** The version this site describes. Kept in step with the root CHANGELOG. */
export const CURRENT_VERSION = "0.1.0";

/**
 * What actually ships today, in one place, so no surface can quietly promote a
 * plan into a product. Every download row, every roadmap card and every status
 * chip on the site reads its wording from this vocabulary.
 */
export type ShipState = "available" | "in development" | "planned";
