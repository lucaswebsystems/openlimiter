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
 * metadata, the social cards, and the structured data.
 *
 * They moved to `meta.title` and `meta.description` in messages/en.json when the
 * site gained four more languages, because a description that only exists in
 * English cannot describe a Portuguese page. They are still written once and
 * still read by every surface; the file they are written in changed.
 *
 * The one thing left here is the suffix below, which is punctuation and a product
 * name rather than a sentence.
 */

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
export const RELEASES_URL = `${REPO_URL}/releases`;
export const LICENSE_URL = `${REPO_URL}/blob/main/LICENSE`;

export const LICENSE_SPDX_URL = "https://www.apache.org/licenses/LICENSE-2.0";

/**
 * A square logo that lives at a fixed path, unlike the generated icon routes,
 * which is what structured data and any third party card needs. It is the same
 * file the installed web application already ships.
 */
export const LOGO_URL = `${SITE_URL}/icons/openlimiter-512.png`;
export const LOGO_SIZE = 512;

/**
 * The two ways to support the work, both live and both claimed. Sponsorship is
 * the only money anywhere near this project: there is no checkout, no paid
 * tier, and no local feature held back to create one.
 */
export const SPONSORS_URL = "https://github.com/sponsors/lucaswebsystems";
export const COFFEE_URL = "https://buymeacoffee.com/lucaswebsystems";

/**
 * OpenLimiter Pro, and the exact words allowed around its one number.
 *
 * Pro is not built. It has never been sold, at any price, to anybody, and no
 * surface on this site may imply otherwise.
 *
 * THERE IS ONE PRICE NOW.
 * ----------------------
 * The $5 founding price and the struck $10 regular price were both retired on
 * 2026-08-15 and replaced by a single $10 with the first month free. Nobody had
 * ever paid either number, so no promise was broken by dropping them, and one
 * price survives translation into five languages where three price sentences
 * kept disagreeing with each other.
 *
 * There is no `PRO_REGULAR_PRICE` any more, and nothing may reintroduce a
 * struck price, a percentage off, an end date or a countdown. All four invent a
 * history this product does not have.
 *
 * THE FREE MONTH IS WRITTEN IN THE FUTURE TENSE, EVERYWHERE.
 * ---------------------------------------------------------
 * The trial cannot begin until there is a service to trial. Its clock starts at
 * first sign in, and sign in does not open until the Pro rails and the first
 * service are both live. So no surface may invite a reader to start a free
 * month today: it says the first month *will be* free, never that it is
 * available now. The day that stops being true, this comment is what changes
 * first.
 *
 * The number lives here and only here, so a translation cannot change a price.
 */
export const PRO_PRICE = "$10";

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
export const CURRENT_VERSION = "0.4.0";

/**
 * What actually ships today, in one place, so no surface can quietly promote a
 * plan into a product. Every download row, every roadmap card and every status
 * chip on the site reads its wording from this vocabulary.
 */
export type ShipState = "available" | "in development" | "planned";
