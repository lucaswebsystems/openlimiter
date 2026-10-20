import { describe, expect, it } from "vitest";
import de from "../messages/de.json";
import en from "../messages/en.json";
import es from "../messages/es.json";
import ja from "../messages/ja.json";
import ptBR from "../messages/pt-BR.json";

/**
 * The status line's room, as the docs describe it in 2.1.7.
 *
 * The bar style keeps to one row of ten block bars: what does not fit the
 * width gives way to the readings closest to their caps, and the line ends with
 * +N more. Only the cells style still stacks onto a second row. The
 * configuration entries for width, rows and stacking, and the command line
 * page's stacking paragraph, said the bar style stacked.
 */

const catalogs = { en, de, es, ja, "pt-BR": ptBR } as const;

describe("the status line docs on running out of room", () => {
  it("say the bar style keeps one row and ends with +N more, and only the cells style stacks, in every locale", () => {
    for (const [locale, catalog] of Object.entries(catalogs)) {
      const statusline = catalog.docs.pages.configuration.sections.statusline;
      const rows = statusline["statusline-keys"].rows;
      expect(rows.width.meaning, `${locale} width`).toContain("+N more");
      expect(rows.width.meaning, `${locale} width`).toContain("<code>cells</code>");
      expect(rows.rows.meaning, `${locale} rows`).toContain("<code>cells</code>");
      expect(rows.rows.meaning, `${locale} rows`).toContain("<code>bar</code>");
      expect(statusline["statusline-stacking"].body, `${locale} stacking`).toContain("+N more");
      expect(statusline["statusline-stacking"].body, `${locale} stacking`).toMatch(/\bcells\b/u);
      expect(catalog.docs.pages.cli.sections.commands.statusline.stacking, `${locale} cli`).toMatch(/\bcells\b/u);
    }
  });
});
