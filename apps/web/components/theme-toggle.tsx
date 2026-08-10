"use client";

import { useEffect, useState } from "react";
import { THEME_ATTR, THEME_STORAGE_KEY, isTheme, type Theme } from "@/lib/theme";

function resolveTheme(): Theme {
  const explicit = document.documentElement.getAttribute(THEME_ATTR);
  if (isTheme(explicit)) return explicit;
  /* No attribute renders the dark palette whatever the system says: the site
     is dark first by declaration in globals.css, and this answer has to
     describe the page that is actually on screen, not the visitor's OS. */
  return "dark";
}

/**
 * Real light and dark toggle.
 *
 * Which icon shows is decided by CSS in globals.css, so the button is correct
 * on the first server rendered paint and reads no browser global during render.
 * The state below exists only to describe the control to assistive technology
 * once it has mounted, which is why it starts as null.
 *
 * It is a real bordered icon button now (founder's order, 2026-08-10), the
 * same family as the sheet trigger and the fold's icon buttons rather than a
 * bare glyph: 36 pixel square, hairline border, the site's one control
 * radius. 36 fits inside the 52 pixel desktop bar with air to spare and
 * clears the 24 pixel target floor with room.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(resolveTheme());
    /* Two instances of this control exist at once on a phone, the hidden
       desktop row's and the sheet's. Each subscribes to the attribute itself,
       so pressing either one updates BOTH descriptions: the attribute on the
       root element is the single truth, and aria-pressed only ever reports
       it. */
    const observer = new MutationObserver(() => setTheme(resolveTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [THEME_ATTR],
    });
    return () => observer.disconnect();
  }, []);

  const toggle = () => {
    const next: Theme = resolveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute(THEME_ATTR, next);
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      /* Private mode can refuse storage. The choice still applies to this page. */
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={theme === null ? undefined : theme === "dark"}
      aria-label="Switch between the light and dark theme"
      title="Switch between the light and dark theme"
      className={`focus-ring inline-flex h-9 w-9 flex-none items-center justify-center rounded-lg border border-hairline-strong text-heading transition-colors hover:border-heading hover:bg-surface ${className}`}
    >
      {/* Moon, offered while the light theme is active. */}
      <svg
        className="icon-to-dark h-[18px] w-[18px] stroke-current"
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5Z"
        />
      </svg>
      {/* Sun, offered while the dark theme is active. */}
      <svg
        className="icon-to-light h-[18px] w-[18px] stroke-current"
        viewBox="0 0 24 24"
        fill="none"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="4" />
        <path
          strokeLinecap="round"
          d="M12 3v2m0 14v2M3 12h2m14 0h2M5.6 5.6l1.4 1.4m10 10 1.4 1.4m0-12.8-1.4 1.4m-10 10-1.4 1.4"
        />
      </svg>
    </button>
  );
}
