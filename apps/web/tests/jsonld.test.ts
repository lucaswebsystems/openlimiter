import { describe, expect, it } from "vitest";
import { jsonLdText } from "@/lib/jsonld";

/**
 * What reaches the inside of a script element.
 *
 * The block is written with dangerouslySetInnerHTML, so the HTML parser reads
 * it rather than a JSON parser, and the HTML parser stops at the first
 * `</script`. Every string in a block comes from a message catalog, and a
 * catalog is the kind of file that eventually holds a sentence nobody reviewed
 * with this in mind, so the escaping is tested rather than remembered.
 */

const HOSTILE = '</script><script>alert(1)</script>';

describe("jsonLdText", () => {
  it("leaves no character the HTML parser can read as markup", () => {
    const text = jsonLdText({ "@type": "Thing", name: HOSTILE });
    expect(text).not.toContain("<");
    expect(text).not.toContain(">");
    expect(text).not.toContain("&");
    expect(text.toLowerCase()).not.toContain("</script");
  });

  it("is still the same JSON, so a crawler reads the value unchanged", () => {
    const parsed = JSON.parse(jsonLdText({ "@type": "Thing", name: HOSTILE }));
    expect(parsed.name).toBe(HOSTILE);
  });

  it("escapes a comment opener, which also ends a script element early", () => {
    const text = jsonLdText({ description: "<!-- hidden" });
    expect(text).not.toContain("<!--");
    expect(JSON.parse(text).description).toBe("<!-- hidden");
  });

  it("escapes an ampersand, so an entity cannot be smuggled through", () => {
    const text = jsonLdText({ description: "quota &lt; limit" });
    expect(text).not.toContain("&");
    expect(JSON.parse(text).description).toBe("quota &lt; limit");
  });

  it("carries an ordinary block through untouched once parsed", () => {
    const node = {
      "@context": "https://schema.org",
      "@type": "SoftwareApplication",
      name: "OpenLimiter",
      offers: [{ "@type": "Offer", price: "5", priceCurrency: "USD" }],
    };
    expect(JSON.parse(jsonLdText(node))).toEqual(node);
  });
});
