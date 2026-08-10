/**
 * The announcement bar's contract, in one file.
 *
 * The bar is server rendered on every marketing page and is not a client
 * component, so it is on the screen in the first paint rather than after a
 * hydration step. Two things are decided here: the sentence it carries, and
 * how a reader who has closed it never sees it again.
 *
 * Closing it writes one key to local storage. `announceArmScript` runs in the
 * head, before the body paints, and sets an attribute on the root element when
 * that key is present; app/globals.css hides the bar under that attribute.
 * Nothing flashes in, nothing flashes out, and a closed bar reserves no space
 * at all, so the header sits where it would if the bar had never existed.
 *
 * The wording is a claim, and it now lives in messages/en.json under
 * `announce`, because the bar is published in five languages. Fifty percent is
 * the founding price against the planned regular price, both of which the
 * pricing card states in full. There is no date and no countdown, because Pro
 * has never been sold and neither number is a price anything was charged at.
 *
 * The sentence used to be spliced here into "Founding p" plus "romo: ...", so a
 * narrow screen could drop the first syllable and still open on a capital. A
 * word cut in half cannot be translated, so the catalog carries two complete
 * sentences instead, `announce.message` and `announce.short`, and the rendered
 * result at both widths is the text it always was.
 */

/** Attribute set on <html> once a reader has closed the bar. */
export const ANNOUNCE_ATTR = "data-announce";

/** The value that attribute takes. Nothing else is ever written to it. */
export const ANNOUNCE_OFF = "off";

/** Storage key holding that choice. */
export const ANNOUNCE_STORAGE_KEY = "openlimiter-announce";

/** Where the bar goes: the section that explains both numbers. */
export const ANNOUNCE_HREF = "/#pricing";

export const announceArmScript = [
  "(function(){try{",
  `if(window.localStorage.getItem("${ANNOUNCE_STORAGE_KEY}")==="${ANNOUNCE_OFF}"){`,
  `document.documentElement.setAttribute("${ANNOUNCE_ATTR}","${ANNOUNCE_OFF}")}`,
  "}catch(e){}})();",
].join("");
