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
const site = loadModule("../components/site-html.tsx", {
  "next/font/google": {
    Inter: () => ({ variable: "inter" }),
    Baloo_2: () => ({ variable: "baloo" }),
  },
  "@/lib/theme": theme,
});
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
  runInNewContext(site.siteThemeArmScript, browser);
  return { browser, root, media, mediaListeners, writes, observers };
}
describe("shared theme behavior", () => {
  for (const [light, stored, expected, origin] of [
    [true, null, "light", "system"],
    [false, null, "dark", "system"],
    [true, "dark", "dark", "user"],
    [false, "light", "light", "user"],
    [true, "invalid", "light", "system"],
  ])
    it(`resolves OS ${light} with stored ${stored} before paint`, () => {
      const fixture = browserFixture(light, stored);
      assert.equal(fixture.root.getAttribute("data-theme"), expected);
      assert.equal(fixture.root.getAttribute("data-theme-source"), origin);
      assert.deepEqual(fixture.writes, []);
    });
  for (const blocked of [false, true])
    it(`follows OS changes until a toggle choice, storage blocked ${blocked}`, () => {
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
      assert.deepEqual(states, ["light", "light"]);
      fixture.media.matches = false;
      fixture.mediaListeners.forEach((callback) => callback());
      assert.deepEqual(states, ["dark", "dark"]);
      first.props.onClick();
      assert.deepEqual(states, ["light", "light"]);
      assert.equal(fixture.root.getAttribute("data-theme-source"), "user");
      fixture.mediaListeners.forEach((callback) => callback());
      assert.equal(fixture.root.getAttribute("data-theme"), "light");
      assert.deepEqual(fixture.writes, blocked ? [] : ["light"]);
      cleanup.forEach((dispose) => dispose());
      assert.equal(fixture.mediaListeners.size, 0);
      assert.equal(fixture.observers.size, 0);
    });
});
describe("global layout contract", () => {
  it("keeps canonical color, font and geometry values out of the web alias layer", () => {
    assert.doesNotMatch(globals, /--ol-(?:font|band)-[\w-]+\s*:/);
    assert.doesNotMatch(globals, /#[\da-f]{3,8}\b|rgba?\(\s*\d/i);
    assert.ok(globals.includes("--spacing: var(--ol-space-1)"));
    assert.ok(
      tokens.includes('--ol-font-heading: var(--ol-font-baloo, "Baloo 2")')
    );
    assert.match(
      tokens,
      /:root\[data-theme="light"\]\s*\{\s*color-scheme: light/
    );
    assert.equal(tokens.match(/--ol-canvas:\s*([^;]+)/g).length, 2);
  });
  it("centers shared prose and overlays without flattening code formatting", () => {
    assert.ok(
      globals.includes(
        ".site-centered :where(pre, pre code) {\n  text-align: start;"
      )
    );
    assert.ok(globals.includes(".site-footer nav {\n  align-items: center;"));
    assert.doesNotMatch(
      source("../components/footer.tsx"),
      /md:(text-left|items-start|justify-start|justify-self-end)/
    );
    assert.ok(source("../components/nav-sheet.tsx").includes("text-center"));
    assert.doesNotMatch(
      source("../app/app/theme.css"),
      /text-align:\s*(left|right)/
    );
  });
  it("shares section spacing, token shadows and a noncollapsing announcement row", () => {
    assert.ok(
      globals.includes("padding-block: calc(var(--ol-section-gap) / 2)")
    );
    assert.ok(globals.includes("margin-top: var(--ol-section-gap)"));
    assert.match(
      globals,
      /\.announce-inner\s*\{[^}]*min-height: var\(--ol-control-height\)/
    );
    assert.ok(
      !source("../components/announcement-bar.tsx").includes("truncate")
    );
    for (const file of ["nav-sheet", "scroll-top"]) {
      assert.ok(!source(`../components/${file}.tsx`).includes("shadow-["));
    }
  });
});
