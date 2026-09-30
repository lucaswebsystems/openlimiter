import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkImportGraph } from "../scripts/import-graph.mjs";
import { moduleReferences, rewriteJsonImports } from "../scripts/ui-modules.mjs";

const dist = fileURLToPath(new URL("./dist/", import.meta.url));
for (const entry of ["index.html", "tray.html", "edge-tab.html", "edge-panel.html"]) {
  test(`built ${entry} imports only existing JavaScript`, () => {
    const files = checkImportGraph(dist, [entry]);
    assert.ok(files.size > 3);
    if (entry === "index.html") {
      for (const file of ["whats-new-data.js", "whats-new.en.json.js", "provider_specs/provider-specs.json.js", "agents.en.json.js"]) {
        assert.ok(files.has(path.join(dist, file)), `${file} must be reachable`);
      }
    }
  });
}

test("generated catalogs preserve the original JSON values", async () => {
  for (const [source, output] of [
    ["../../../provider_specs/provider-specs.json", "provider_specs/provider-specs.json.js"],
    ["agents.en.json", "agents.en.json.js"], ["whats-new.en.json", "whats-new.en.json.js"],
  ]) {
    const expected = JSON.parse(readFileSync(new URL(source, import.meta.url), "utf8"));
    const actual = await import(new URL(`./dist/${output}`, import.meta.url));
    assert.deepEqual(actual.default, expected);
  }
});

test("JSON conversion handles static, side effect, reexport and literal dynamic imports", () => {
  const source = `// import fake from './ignored.json';
const text = "import('./ignored.json')";
import data from './a.json' with { type: 'json' };
import './b.json';
export { default as data } from './c.json' assert { type: 'json' };
const lazy = () => import('./d.json', { with: { type: 'json' } });
const template = () => import(\`./e.json\`);`;
  const rewritten = rewriteJsonImports(source, specifier => specifier + ".js");
  assert.deepEqual(moduleReferences(rewritten).map(ref => ref.specifier),
    ["./a.json.js", "./b.json.js", "./c.json.js", "./d.json.js", "./e.json.js"]);
  assert.ok(!rewritten.includes("type: 'json'"));
  assert.ok(rewritten.includes("// import fake from './ignored.json'"));
});

test("graph rejects missing scripts and JSON imports, including lazy modules", t => {
  const directory = mkdtempSync(path.join(tmpdir(), "openlimiter-imports-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const write = (file, source) => writeFileSync(path.join(directory, file), source);
  mkdirSync(path.join(directory, "nested"));
  write("index.html", '<script type="module" src="./entry.js"></script>');
  for (const source of ["import './missing.js';", "export * from './missing.js';", "import('./missing.js');"]) {
    write("entry.js", source);
    assert.throws(() => checkImportGraph(directory, ["index.html"]), /Missing script/u);
  }
  write("entry.js", "import './nested/child.js';");
  for (const source of ["import value from '../data.json' with {type:'json'};", "import('../data.json', {with:{type:'json'}});", "export {default} from '../data.json';"]) {
    write("nested/child.js", source);
    assert.throws(() => checkImportGraph(directory, ["index.html"]), /JSON import/u);
  }
  write("nested/child.js", "import '../entry.js';");
  assert.equal(checkImportGraph(directory, ["index.html"]).size, 3);
  write("index.html", '<script src="./absent.js"></script>');
  assert.throws(() => checkImportGraph(directory, ["index.html"]), /Missing script/u);
  write("index.html", '<script type="module">import("./absent.js")</script>');
  assert.throws(() => checkImportGraph(directory, ["index.html"]), /Missing script/u);
});
