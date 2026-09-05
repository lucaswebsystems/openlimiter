import { jsonLdText, type JsonLdNode } from "@/lib/jsonld";

/**
 * One structured data block.
 *
 * A server component with no state and no effect, so the script tag is present
 * in the HTML a crawler receives rather than being written after hydration.
 * Nothing here runs in a browser.
 *
 * The serialisation, and the escaping that goes with it, is lib/jsonld.ts's
 * job: see `jsonLdText`. Nothing is escaped here, so there is one definition of
 * what is safe to put inside a script element rather than one per call site.
 */
export function JsonLd({ data }: { data: JsonLdNode }) {
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLdText(data) }} />;
}
