/**
 * Remove one query parameter from the visible address, without a navigation.
 *
 * A one time code, whether a terminal sign in code or an OAuth authorization
 * code, is spent the moment this page reads it, but the address bar keeps
 * showing it, the browser's own history keeps it too, and a Referer header on
 * any request this page went on to make would have carried it along. Nothing
 * here can undo a code already read out loud by the URL that delivered it,
 * but there is no reason to keep saying it after: the parameter is dropped
 * from the current entry the instant this page has read it, so a "back" a
 * moment later, a copied link, or a screen share does not hand it out again.
 */
export function stripQueryParam(name: string): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(name)) return;
    url.searchParams.delete(name);
    const query = url.searchParams.toString();
    window.history.replaceState(
      window.history.state as unknown,
      "",
      url.pathname + (query === "" ? "" : "?" + query) + url.hash,
    );
  } catch {
    /* An address bar this build cannot rewrite is not worth failing over. */
  }
}
