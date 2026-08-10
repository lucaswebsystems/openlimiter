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
 * The wording is a claim, so it is written once, here. Fifty percent is the
 * founding price against the planned regular price, both of which the pricing
 * card states in full. There is no date and no countdown, because Pro has
 * never been sold and neither number is a price anything was charged at.
 */

/** Attribute set on <html> once a reader has closed the bar. */
export const ANNOUNCE_ATTR = "data-announce";

/** The value that attribute takes. Nothing else is ever written to it. */
export const ANNOUNCE_OFF = "off";

/** Storage key holding that choice. */
export const ANNOUNCE_STORAGE_KEY = "openlimiter-announce";

/** The whole sentence, and the one a screen reader is given. */
export const ANNOUNCE_MESSAGE =
  "Founding promo: OpenLimiter Pro at 50% OFF for early supporters";

/**
 * The first word, split off so a narrow screen can drop it and keep a sentence
 * that still starts with a capital. The two halves join back into
 * `ANNOUNCE_MESSAGE` exactly, and the visible copy is hidden from assistive
 * technology precisely because it is rendered in two pieces.
 */
export const ANNOUNCE_LEAD = "Founding p";
export const ANNOUNCE_LEAD_SHORT = "P";
export const ANNOUNCE_REST = "romo: OpenLimiter Pro at 50% OFF for early supporters";

/** Where the bar goes: the section that explains both numbers. */
export const ANNOUNCE_HREF = "/#pricing";

export const announceArmScript = [
  "(function(){try{",
  `if(window.localStorage.getItem("${ANNOUNCE_STORAGE_KEY}")==="${ANNOUNCE_OFF}"){`,
  `document.documentElement.setAttribute("${ANNOUNCE_ATTR}","${ANNOUNCE_OFF}")}`,
  "}catch(e){}})();",
].join("");
