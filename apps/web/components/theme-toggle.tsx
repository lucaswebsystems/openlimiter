"use client";

import { useEffect, useState } from "react";
import { THEME_ATTR, THEME_STORAGE_KEY, isTheme, type Theme } from "@/lib/theme";

function resolveTheme(): Theme {
  const explicit = document.documentElement.getAttribute(THEME_ATTR);
  if (isTheme(explicit)) return explicit;
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/**
 * Real light and dark toggle.
 *
 * Which icon shows is decided by CSS in globals.css, so the button is correct
 * on the first server rendered paint and reads no browser global during render.
 * The state below exists only to describe the control to assistive technology
 * once it has mounted, which is why it starts as null.
 *
 * It is drawn as a bare 18 pixel icon, the same size and colour as the GitHub
 * mark beside it, so the header row stays 28 pixels tall.
 */
export function ThemeToggle({ className = "" }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(resolveTheme());
  }, []);

  const toggle = () => {
    const next: Theme = resolveTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute(THEME_ATTR, next);
    setTheme(next);
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
      className={`focus-ring inline-flex items-center justify-center rounded text-muted transition-colors hover:text-heading ${className}`}
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
