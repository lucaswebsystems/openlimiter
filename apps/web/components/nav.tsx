"use client";

import Link from "next/link";
import { useState } from "react";

export function Nav() {
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <header className="sticky top-0 z-50 w-full border-b border-hairline bg-canvas/85 backdrop-blur-md">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        {/* Wordmark and mark */}
        <Link href="/" className="flex items-center gap-2.5 group">
          <div className="flex h-7 w-7 items-center justify-center rounded-md border border-hairline-strong bg-surface text-xs font-semibold text-heading shadow-sm transition-colors group-hover:border-accent">
            OL
          </div>
          <span className="font-sans text-sm font-medium tracking-tight text-heading">
            OpenLimiter
          </span>
          <span className="ml-1.5 hidden rounded-full border border-hairline bg-surface/60 px-2 py-0.5 font-mono text-[10px] font-medium text-label sm:inline-block">
            v0.1.0
          </span>
        </Link>

        {/* Desktop Nav Links */}
        <nav className="hidden items-center gap-6 md:flex">
          <a
            href="#how-it-works"
            className="text-xs font-medium text-body transition-colors hover:text-heading"
          >
            How it works
          </a>
          <a
            href="#providers"
            className="text-xs font-medium text-body transition-colors hover:text-heading"
          >
            Providers
          </a>
          <a
            href="#pricing"
            className="text-xs font-medium text-body transition-colors hover:text-heading"
          >
            Pricing
          </a>
          <a
            href="https://github.com/lucaswebsystems/openlimiter#readme"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs font-medium text-body transition-colors hover:text-heading"
          >
            Docs
          </a>
          <a
            href="https://github.com/lucaswebsystems/openlimiter"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 text-xs font-medium text-body transition-colors hover:text-heading"
          >
            <svg
              className="h-3.5 w-3.5 fill-current"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z" />
            </svg>
            GitHub
          </a>
        </nav>

        {/* Mobile menu button */}
        <button
          type="button"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="focus-ring flex h-8 w-8 items-center justify-center rounded-md border border-hairline text-body hover:text-heading md:hidden"
          aria-expanded={mobileMenuOpen}
          aria-label="Toggle navigation menu"
        >
          <svg
            className="h-4 w-4 stroke-current"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth="2"
          >
            {mobileMenuOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile nav dropdown */}
      {mobileMenuOpen && (
        <div className="border-b border-hairline bg-surface/95 px-4 py-4 md:hidden">
          <nav className="flex flex-col gap-3">
            <a
              href="#how-it-works"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm font-medium text-body hover:text-heading"
            >
              How it works
            </a>
            <a
              href="#providers"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm font-medium text-body hover:text-heading"
            >
              Providers
            </a>
            <a
              href="#pricing"
              onClick={() => setMobileMenuOpen(false)}
              className="text-sm font-medium text-body hover:text-heading"
            >
              Pricing
            </a>
            <a
              href="https://github.com/lucaswebsystems/openlimiter#readme"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm font-medium text-body hover:text-heading"
            >
              Docs
            </a>
            <a
              href="https://github.com/lucaswebsystems/openlimiter"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 text-sm font-medium text-body hover:text-heading"
            >
              GitHub
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
