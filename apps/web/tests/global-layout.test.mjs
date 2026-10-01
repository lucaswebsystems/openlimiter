import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
const source = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const globals = source("../app/globals.css");
const tokens = source("../../../packages/ui/src/tokens.css");
function loadModule(path, imports, browser = {}) {
  const result = ts.transpileModule(source(path), {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      jsx: ts.JsxEmit.ReactJSX,
    },
    reportDiagnostics: true,
  });
  assert.deepEqual(result.diagnostics, []);
  const exports = {};
  runInNewContext(result.outputText, {
    exports,
    require: (id) => imports[id] ?? {},
    ...browser,
  });
  return exports;
}
const theme = loadModule("../lib/theme.ts", {});
function browserFixture(light, saved = null, storageBlocked = false) {
  const attributes = new Map();
  const observers = new Set();
  const mediaListeners = new Set();
  const writes = [];
  const root = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => {
      attributes.set(name, value);
      observers.forEach((callback) => callback());
    },
  };
  const media = {
    matches: light,
    addEventListener: (_, callback) => mediaListeners.add(callback),
    removeEventListener: (_, callback) => mediaListeners.delete(callback),
  };
  const browser = {
    document: { documentElement: root },
    window: {
      matchMedia: () => media,
      localStorage: {
        getItem: () => {
          if (storageBlocked) throw new Error("Storage unavailable");
          return saved;
        },
        setItem: (_, value) => {
          if (storageBlocked) throw new Error("Storage unavailable");
          writes.push(value);
        },
      },
    },
    MutationObserver: class {
      callback;
      constructor(callback) {
        this.callback = callback;
      }
      observe() {
        observers.add(this.callback);
      }
      disconnect() {
        observers.delete(this.callback);
      }
    },
  };
  runInNewContext(theme.themeArmScript, browser);
  return { browser, root, media, mediaListeners, writes, observers };
}
describe("shared theme behavior", () => {
  for (const [light, stored, expected] of [
    [true, null, null],
    [false, null, null],
    [true, "dark", "dark"],
    [false, "light", "light"],
    [true, "invalid", null],
  ])
    it(`keeps the dark default for OS ${light} with stored ${stored}`, () => {
      const fixture = browserFixture(light, stored);
      assert.equal(fixture.root.getAttribute("data-theme"), expected);
      assert.deepEqual(fixture.writes, []);
    });
  for (const blocked of [false, true])
    it(`toggles the explicit theme from the dark default, storage blocked ${blocked}`, () => {
      const fixture = browserFixture(true, null, blocked);
      const cleanup = [];
      const states = [];
      const { ThemeToggle } = loadModule(
        "../components/theme-toggle.tsx",
        {
          "@/lib/theme": theme,
          "next-intl": { useTranslations: () => (key) => key },
          react: {
            useEffect: (effect) => cleanup.push(effect()),
            useState: (initial) => {
              const index = states.push(initial) - 1;
              return [
                initial,
                (value) => {
                  states[index] = value;
                },
              ];
            },
          },
          "react/jsx-runtime": {
            jsx: (type, props) => ({ type, props }),
            jsxs: (type, props) => ({ type, props }),
          },
        },
        fixture.browser
      );
      const first = ThemeToggle({});
      ThemeToggle({});
      assert.deepEqual(states, ["dark", "dark"]);
      fixture.media.matches = false;
      fixture.mediaListeners.forEach((callback) => callback());
      assert.deepEqual(states, ["dark", "dark"]);
      first.props.onClick();
      assert.deepEqual(states, ["light", "light"]);
      fixture.mediaListeners.forEach((callback) => callback());
      assert.equal(fixture.root.getAttribute("data-theme"), "light");
      assert.deepEqual(fixture.writes, blocked ? [] : ["light"]);
      cleanup.forEach((dispose) => dispose());
      assert.equal(fixture.mediaListeners.size, 0);
      assert.equal(fixture.observers.size, 0);
    });
});
describe("global layout contract", () => {
  it("keeps the historical site palette while retaining shared desktop tokens", () => {
    assert.ok(
      tokens.includes('--ol-font-heading: var(--ol-font-baloo, "Baloo 2")')
    );
    assert.ok(
      globals.includes('--ol-font-heading: var(--ol-font-baloo, "Baloo 2")')
    );
    assert.ok(globals.includes("--ol-announce: var(--ol-accent-solid)"));
    assert.match(
      tokens,
      /:root\[data-theme="light"\]\s*\{\s*color-scheme: light/
    );
    assert.equal(tokens.match(/--ol-canvas:\s*([^;]+)/g).length, 2);
  });
  it("restores left aligned public layouts and product controls", () => {
    assert.doesNotMatch(globals, /\.site-centered|\.site-footer nav|\.page-shell\s*\{/);
    assert.match(
      source("../components/footer.tsx"),
      /md:(text-left|items-start|justify-start|justify-self-end)/
    );
    assert.ok(!source("../components/site-html.tsx").includes("site-centered"));
    assert.ok(!source("../components/nav-sheet.tsx").includes("text-center"));
    assert.match(
      source("../app/app/theme.css"),
      /text-align:\s*(left|right)/
    );
  });
  it("restores the former spacing, shadows and fixed announcement row", () => {
    assert.ok(source("../components/page-shell.tsx").includes("space-y-24"));
    assert.ok(source("../app/[locale]/page.tsx").includes("py-16 md:py-24"));
    assert.ok(source("../components/announcement-bar.tsx").includes("truncate"));
    assert.ok(source("../components/announcement-bar.tsx").includes("h-[var(--ol-announce-h)]"));
    for (const file of ["nav-sheet", "scroll-top"]) {
      assert.ok(source(`../components/${file}.tsx`).includes("shadow-["));
    }
  });
});
