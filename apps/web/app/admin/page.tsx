import type { Metadata } from "next";
import { PageShell } from "@/components/page-shell";
import { proRailsEnabled } from "@/lib/pro";

/**
 * /admin
 *
 * The founder console for OpenLimiter Pro, behind the Pro rails flag from
 * lib/pro.ts. With the flag off, which is every build today, the route renders
 * one plain sentence and nothing else: no sign in, no Supabase code fetched,
 * no configuration implied. With the flag on it renders the client side shell,
 * which signs the founder in by magic link and talks to the Pro tables under
 * row level security.
 *
 * Deliberately noindexed and deliberately absent from the sitemap: this is an
 * internal surface, not a public page.
 */

export const metadata: Metadata = {
  title: "Admin",
  description: "Founder console for OpenLimiter Pro.",
  alternates: { canonical: "/admin" },
  robots: { index: false, follow: false },
};

export default function AdminPage() {
  if (!proRailsEnabled) {
    return <PageShell title="Admin" lead="Admin is not enabled in this build.">{null}</PageShell>;
  }

  return null;
}
