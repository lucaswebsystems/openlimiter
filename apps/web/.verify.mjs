import { chromium } from "playwright";
const U = "https://web-t735d1l3c-lucas-teixeiras-projects-6a465d1f.vercel.app";
const OUT = "C:/Users/lucas/AppData/Local/Temp/claude/C--Users-lucas-Desktop-Claude-Personal-OpenLimiter/b7daae9e-3910-4816-944b-c51cafd35b37/scratchpad";
const b = await chromium.launch({ args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "dark" });
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
p.on("response", (r) => { if (r.status() >= 400 && !r.url().includes("_vercel/insights")) errs.push(`${r.status()} ${r.url()}`); });
await p.goto(U, { waitUntil: "networkidle" });
await p.waitForTimeout(4000);
await p.screenshot({ path: `${OUT}/LIVE-preview-hero.png` });
const state = await p.evaluate(() => {
  const host = document.querySelector("[data-hero-canvas]");
  const t = document.body.innerText;
  return {
    canvasReady: !!host?.hasAttribute("data-ready"),
    canvasEl: !!host?.querySelector("canvas"),
    tenDollar: (t.match(/\$10/g) || []).length,
    thirtyDays: (t.match(/30 days/g) || []).length,
    oldOffer: (t.match(/50% OFF|founding price|\$5\b/g) || []).length,
  };
});
console.log("LIVE PREVIEW:", JSON.stringify(state, null, 1));
console.log("errors:", errs.length ? errs.join(" | ") : "NONE");
await b.close();
