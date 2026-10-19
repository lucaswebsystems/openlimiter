"use client";

import { Analytics, type BeforeSendEvent } from "@vercel/analytics/next";

/**
 * The cookieless page view count, with the campaign written into the path.
 *
 * The Hobby plan shows pages but not query strings, so a visit from a tagged
 * link would be counted with its source thrown away. This puts the source in
 * the one field the dashboard does show: `/download?utm_source=reddit&
 * utm_content=a` is recorded as `/download/via/reddit-a`. Nothing is stored in
 * the browser, nothing new is sent, and an untagged visit is recorded exactly
 * as before.
 */

/** A tag value as a path segment: lower case letters and digits only, capped. */
function segment(value: string | null): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 40);
}

export function withCampaignPath(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const source = segment(parsed.searchParams.get("utm_source"));
  if (source === "") return url;
  const content = segment(parsed.searchParams.get("utm_content"));
  const via = content === "" ? source : `${source}-${content}`;
  parsed.pathname = `${parsed.pathname.replace(/\/+$/u, "")}/via/${via}`;
  return parsed.toString();
}

function beforeSend(event: BeforeSendEvent): BeforeSendEvent {
  return { ...event, url: withCampaignPath(event.url) };
}

export function SiteAnalytics() {
  return <Analytics beforeSend={beforeSend} />;
}
