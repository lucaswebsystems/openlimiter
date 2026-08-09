/**
 * Shared contract for the colour theme.
 *
 * The visitor's system preference is the default. Nothing is written to storage
 * until the toggle is used, and an explicit choice then wins over the system in
 * both directions. The palettes themselves live in app/globals.css: this module
 * only decides which one is active.
 */

/** Attribute set on <html> when an explicit choice exists. */
export const THEME_ATTR = "data-theme";

/** Storage key holding that explicit choice. */
export const THEME_STORAGE_KEY = "openlimiter-theme";

export type Theme = "light" | "dark";

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

/**
 * Runs before the body paints, so the stored choice is applied without a flash
 * of the other theme. It touches only the attribute: every colour still comes
 * from the stylesheet, and a browser that throws on storage simply keeps the
 * system preference.
 */
export const themeArmScript = [
  "(function(){try{",
  `var v=window.localStorage.getItem("${THEME_STORAGE_KEY}");`,
  `if(v==="light"||v==="dark"){document.documentElement.setAttribute("${THEME_ATTR}",v)}`,
  "}catch(e){}})();",
].join("");
