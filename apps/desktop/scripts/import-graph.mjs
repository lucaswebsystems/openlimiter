import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { htmlScripts, moduleReferences } from "./ui-modules.mjs";

/** Check the files the browser can reach, including lazy literal imports. */
export function checkImportGraph(directory, entries = ["index.html", "tray.html", "edge-tab.html", "edge-panel.html"]) {
  const root = path.resolve(directory);
  const visited = new Set();
  function follow(specifier, importer) {
    if (/\.json(?:[?#]|$)/iu.test(specifier)) throw new Error(`JSON import: ${specifier} in ${importer}`);
    if (/^[a-z][a-z\d+.-]*:|^\/\//iu.test(specifier)) throw new Error(`Nonlocal script: ${specifier} in ${importer}`);
    const target = specifier.startsWith("/")
      ? new URL(`.${specifier}`, pathToFileURL(root + path.sep))
      : new URL(specifier, pathToFileURL(importer));
    visit(fileURLToPath(target));
  }
  function javascript(source, file) {
    for (const { specifier } of moduleReferences(source, file)) {
      if (!/^(?:\.{1,2}\/|\/)/u.test(specifier)) throw new Error(`Unresolved module: ${specifier} in ${file}`);
      follow(specifier, file);
    }
  }
  function visit(file) {
    const relative = path.relative(root, file);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Script escapes ui/dist: ${file}`);
    if (visited.has(file)) return;
    if (!statSync(file, { throwIfNoEntry: false })?.isFile()) throw new Error(`Missing script: ${relative}`);
    visited.add(file);
    const source = readFileSync(file, "utf8");
    if (file.endsWith(".html")) {
      for (const script of htmlScripts(source)) {
        if (script.src !== undefined) follow(script.src, file);
        else javascript(script.source, file);
      }
    } else javascript(source, file);
  }
  for (const entry of entries) visit(path.resolve(root, entry));
  return visited;
}
