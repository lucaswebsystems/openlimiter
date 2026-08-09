"use client";

import Link from "next/link";
import { useState } from "react";
import { BrandLockup } from "./brand";
import { GitHubMark } from "./ui";
import { ThemeToggle } from "./theme-toggle";
import { REPO_URL } from "@/lib/site";

const links = [
  { label: "Docs", href: "/docs" },
  { label: "Providers", href: "/#providers" },
  { label: "Pricing", href: "/#pricing" },
  { label: "FAQ", href: "/#faq" },
];

export function Nav() {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-hairline bg-canvas/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <Link href="/" aria-label="OpenLimiter, home" className="focus-ring flex rounded-md">
          {/* The one instance allowed to play the draw in. See lib/brand.ts. */}
          <BrandLockup draw markClassName="h-7 w-7 flex-none text-accent-solid" wordClassName="text-base" />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-6 md:flex">
          {links.map((link) => (
            <Link
              key={link.label}
              href={link.href}
              className="focus-ring rounded text-sm font-medium text-body transition-colors hover:text-heading"
            >
              {link.label}
            </Link>
          ))}
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="focus-ring flex items-center gap-1.5 rounded text-sm font-medium text-body transition-colors hover:text-heading"
          >
            <GitHubMark className="h-4 w-4" />
            GitHub
          </a>
        </nav>

        <div className="flex items-center gap-2">
          <ThemeToggle />
          <button
            type="button"
            onClick={() => setMenuOpen(!menuOpen)}
            className="focus-ring flex h-8 w-8 items-center justify-center rounded-md border border-hairline bg-surface text-muted transition-colors hover:text-heading md:hidden"
            aria-expanded={menuOpen}
            aria-controls="mobile-menu"
            aria-label="Toggle the navigation menu"
          >
            <svg className="h-4 w-4 stroke-current" fill="none" viewBox="0 0 24 24" strokeWidth="1.8" aria-hidden="true">
              {menuOpen ? (
                <path strokeLinecap="round" strokeLinejoin="round" d="M6 18 18 6M6 6l12 12" />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M4 7h16M4 12h16M4 17h16" />
              )}
            </svg>
          </button>
        </div>
      </div>

      {menuOpen && (
        <div id="mobile-menu" className="border-t border-hairline bg-surface px-4 py-4 md:hidden">
          <nav aria-label="Main, compact" className="flex flex-col gap-3">
            {links.map((link) => (
              <Link
                key={link.label}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="focus-ring rounded text-sm font-medium text-body hover:text-heading"
              >
                {link.label}
              </Link>
            ))}
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="focus-ring flex items-center gap-2 rounded text-sm font-medium text-body hover:text-heading"
            >
              <GitHubMark className="h-4 w-4" />
              GitHub
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
