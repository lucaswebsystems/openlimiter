import type { MetadataRoute } from "next";
import { alternatives } from "@/lib/alternatives";
import { posts } from "@/lib/blog";
import { docPages } from "@/lib/docs";
import { SITE_URL } from "@/lib/site";

/**
 * Every public route, generated from the same lists the pages render, so a page
 * cannot exist in the navigation and be missing from the sitemap.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const lastModified = new Date();
  const monthly = "monthly" as const;

  return [
    { url: SITE_URL, lastModified, changeFrequency: monthly, priority: 1 },
    { url: `${SITE_URL}/app`, lastModified, changeFrequency: monthly, priority: 0.9 },
    { url: `${SITE_URL}/download`, lastModified, changeFrequency: monthly, priority: 0.9 },
    { url: `${SITE_URL}/changelog`, lastModified, changeFrequency: monthly, priority: 0.7 },
    { url: `${SITE_URL}/blog`, lastModified, changeFrequency: monthly, priority: 0.7 },
    { url: `${SITE_URL}/alternatives`, lastModified, changeFrequency: monthly, priority: 0.7 },
    ...docPages.map((page) => ({
      url: `${SITE_URL}${page.href}`,
      lastModified,
      changeFrequency: monthly,
      priority: 0.8,
    })),
    ...posts.map((post) => ({
      url: `${SITE_URL}/blog/${post.slug}`,
      lastModified,
      changeFrequency: monthly,
      priority: 0.6,
    })),
    ...alternatives.map((entry) => ({
      url: `${SITE_URL}/alternatives/${entry.slug}`,
      lastModified,
      changeFrequency: monthly,
      priority: 0.6,
    })),
  ];
}
