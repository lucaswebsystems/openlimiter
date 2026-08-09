import type { JsonLdNode } from "@/lib/jsonld";

/**
 * One structured data block.
 *
 * A server component with no state and no effect, so the script tag is present
 * in the HTML a crawler receives rather than being written after hydration.
 * Nothing here runs in a browser.
 *
 * The opening angle bracket of every string is escaped to its JSON unicode form
 * before the JSON reaches the document. It is valid JSON either way, and it
 * means no value can ever close this script tag early. The strings on this site
 * are all authored, but a block that depends on remembering that is a block
 * waiting to break.
 */
export function JsonLd({ data }: { data: JsonLdNode }) {
  const json = JSON.stringify(data).replace(/</g, "\\u003c");

  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: json }} />;
}
