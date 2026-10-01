// Run against a local server: node tests/home-layout.browser.mjs http://127.0.0.1:3127
import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = new URL(process.argv[2] ?? "http://127.0.0.1:3127");
assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname), "Use a local preview server");
const browser = await chromium.launch({ headless: true });
let checked = 0;
try {
  for (const locale of ["en", "pt-BR", "es", "de", "ja"]) {
    for (const width of [375, 768, 1024, 1440]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: 2, reducedMotion: "reduce" });
      const page = await context.newPage();
      await page.goto(new URL(locale === "en" ? "/" : `/${locale}`, origin).href);
      await page.locator("#pricing").waitFor();
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
        for (const img of await page.locator("main picture img").all()) {
          await img.scrollIntoViewIfNeeded();
          await img.evaluate(async (image) => { await image.decode(); });
        }
        await page.waitForFunction((value) => [...document.querySelectorAll("main picture img")].every((img) => img.currentSrc.includes(value === "light" ? "-light@" : "@") && (value === "light" || !img.currentSrc.includes("-light@"))), theme);
        const result = await page.evaluate(() => {
          const main = document.querySelector("main");
          const rect = (el) => el.getBoundingClientRect();
          const images = [...main.querySelectorAll("picture img")].map((img) => ({
            width: rect(img).width,
            sourceWidth: Number(img.getAttribute("width")),
            src: img.currentSrc,
            loading: img.loading,
          }));
          const globallyCentered = main.classList.contains("text-center") || getComputedStyle(document.body).textAlign === "center";
          const logoColors = [...main.querySelectorAll('.hero-fold a[href*="/download#"] svg')].filter((el) => rect(el).width > 0).map((el) => getComputedStyle(el).color);
          return { overflow: document.documentElement.scrollWidth > innerWidth, images, globallyCentered, logoColors };
        });
        const label = `${locale} ${width}px ${theme}`;
        assert.equal(result.overflow, false, `${label}: horizontal overflow`);
        assert.equal(result.globallyCentered, false, `${label}: restored page alignment`);
        assert.ok(result.logoColors.every((color) => color === "rgb(255, 255, 255)"), `${label}: white platform logos`);
        for (const img of result.images) {
          assert.ok(img.width * 2 <= img.sourceWidth, `${label}: screenshot resolution`);
          assert.match(img.src, /@(?:2|3)x\.webp$/, `${label}: WebP density`);
          assert.equal(img.loading, "lazy", `${label}: below fold loading`);
        }
        checked += 1;
      }
      await context.close();
    }
  }
  console.log(`PASS: ${checked} home layouts across five locales, four widths and both themes.`);
} finally {
  await browser.close();
}
