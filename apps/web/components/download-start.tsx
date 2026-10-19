"use client";

import { useEffect } from "react";

/**
 * Starts the file download once the next steps are on screen.
 *
 * The page view of /download/started is what counts a download click, so the
 * file starts from here rather than from the button. A file response leaves
 * this page where it is, and the manual link beside the steps covers a browser
 * that blocks it.
 *
 * ponytail: a fixed one second delay, so the reader sees the steps first; make
 * it a prop if a page ever needs another.
 */
export function DownloadStart({ href }: { href: string }) {
  useEffect(() => {
    const timer = window.setTimeout(() => window.location.assign(href), 1000);
    return () => window.clearTimeout(timer);
  }, [href]);
  return null;
}
