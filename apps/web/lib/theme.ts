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
export type ThemeChoice = Theme | "system";

export const THEME_COLORS: Record<Theme, string> = {
  light: "#f4f7fb",
  dark: "#080b10",
};

export function isTheme(value: unknown): value is Theme {
  return value === "light" || value === "dark";
}

export function systemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(choice: ThemeChoice): Theme {
  const theme = choice === "system" ? systemTheme() : choice;
  document.documentElement.setAttribute(THEME_ATTR, theme);
  try {
    if (choice === "system") window.localStorage.removeItem(THEME_STORAGE_KEY);
    else window.localStorage.setItem(THEME_STORAGE_KEY, choice);
  } catch {
    /* Storage is optional. The visible choice still applies to this page. */
  }
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", THEME_COLORS[theme]);
  return theme;
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
  'var s=window.matchMedia("(display-mode: standalone)").matches||window.navigator.standalone===true;',
  'var t=(v==="light"||v==="dark")?v:(s?(window.matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"):null);',
  `if(t){document.documentElement.setAttribute("${THEME_ATTR}",t)}`,
  `var m=document.querySelector('meta[name="theme-color"]');if(m){m.setAttribute("content",t==="light"?"${THEME_COLORS.light}":"${THEME_COLORS.dark}")}`,
  "}catch(e){}})();",
].join("");
