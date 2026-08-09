import { REPO_NAME, REPO_OWNER } from "./site";

/**
 * The live star count, read from the GitHub API when the page is rendered.
 *
 * There is exactly one honest failure mode here and it is silence. If the
 * request times out, the repository is private, the rate limit is spent, or the
 * body is not the shape the API documents, this returns null and the caller
 * renders the plain GitHub link with no number beside it. Nothing in this file
 * can produce a count that did not come from GitHub, so the site can never show
 * an invented one.
 *
 * The result is cached for an hour, which is short enough that the number is
 * current and long enough that a build or a burst of traffic never spends the
 * unauthenticated rate limit.
 */

const API_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}`;
const REVALIDATE_SECONDS = 3600;
const TIMEOUT_MS = 4000;

export async function fetchStarCount(): Promise<number | null> {
  try {
    const response = await fetch(API_URL, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "openlimiter-website",
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      next: { revalidate: REVALIDATE_SECONDS },
    });

    if (!response.ok) return null;

    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return null;

    const count = (body as { stargazers_count?: unknown }).stargazers_count;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 0) {
      return null;
    }

    return Math.trunc(count);
  } catch {
    /* Offline builds, private repositories and spent rate limits all land
       here. The chip simply carries no number. */
    return null;
  }
}

/**
 * GitHub's own compact form: exact below a thousand, one decimal above it.
 * 999 stays 999, 1000 becomes 1k, 12862 becomes 12.9k.
 */
export function formatStarCount(count: number): string {
  if (count < 1000) return String(count);
  const thousands = count / 1000;
  const rounded = Math.round(thousands * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}k`;
}
