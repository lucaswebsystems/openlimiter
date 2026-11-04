#!/usr/bin/env node
/**
 * Checks every link on the documentation and changelog pages.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(HERE, "..");
export const APP_DIR = path.resolve(WEB_ROOT, "app");
export const DOCS_DIR = path.resolve(APP_DIR, "[locale]", "docs");
export const CHANGELOG_PAGE = path.resolve(APP_DIR, "[locale]", "changelog", "page.tsx");
export const REPO_ROOT = path.resolve(WEB_ROOT, "..", "..");

async function readSite() {
  const source = await readFile(new URL("../lib/site.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
}

function walkFiles(directory, predicate) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(fullPath, predicate));
    else if (predicate(fullPath)) result.push(fullPath);
  }
  return result;
}

function fileToRoute(filePath) {
  const relative = path.relative(APP_DIR, filePath);
  const parts = relative.split(path.sep);
  parts.pop();
  const segments = parts.filter((segment) => segment !== "[locale]" && !/^\(.*\)$/u.test(segment));
  return segments.length === 0 ? "/" : "/" + segments.join("/");
}

function parseChangelogVersions() {
  try {
    const source = readFileSync(path.join(REPO_ROOT, "CHANGELOG.md"), "utf8");
    const versions = [];
    for (const match of source.matchAll(/^##\s+\[?([^\]\s]+)\]?/gmu)) versions.push(match[1]);
    return versions;
  } catch {
    return [];
  }
}

function collectAnchorsFromFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const anchors = new Set();
  function visit(node, currentElement) {
    let nextElement = currentElement;
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      nextElement = node.tagName.getText(sourceFile);
    }
    if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "id" && node.initializer) {
      let value = null;
      if (ts.isStringLiteral(node.initializer)) value = node.initializer.text;
      else if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        const expression = node.initializer.expression;
        if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) value = expression.text;
      }
      if (value !== null && currentElement !== "DocArticle") anchors.add(value);
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(sourceFile) === "sections" && ts.isArrayLiteralExpression(node.initializer)) {
      for (const element of node.initializer.elements) {
        if (ts.isObjectLiteralExpression(element)) {
          for (const property of element.properties) {
            if (ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === "id" && ts.isStringLiteral(property.initializer)) {
              anchors.add(property.initializer.text);
            }
          }
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, nextElement));
  }
  visit(sourceFile, null);
  return anchors;
}

export function collectRoutes() {
  const pageFiles = walkFiles(APP_DIR, (file) => path.basename(file) === "page.tsx");
  const routes = new Set();
  const anchorsByRoute = new Map();
  for (const file of pageFiles) {
    const route = fileToRoute(file);
    routes.add(route);
    anchorsByRoute.set(route, collectAnchorsFromFile(file));
  }
  const changelogRoute = "/changelog";
  if (anchorsByRoute.has(changelogRoute)) {
    for (const version of parseChangelogVersions()) anchorsByRoute.get(changelogRoute).add("v" + version);
  }
  if (!routes.has("/")) routes.add("/");
  return { routes, anchorsByRoute };
}

function resolveExpression(expression, site) {
  if (expression === undefined || expression === null) return null;
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const resolved = resolveExpression(span.expression, site);
      if (resolved === null) return null;
      value += resolved + span.literal.text;
    }
    return value;
  }
  if (ts.isIdentifier(expression)) {
    if (Object.prototype.hasOwnProperty.call(site, expression.text)) return site[expression.text];
    return null;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    const objectValue = resolveExpression(expression.expression, site);
    if (objectValue !== null && typeof objectValue === "object") return objectValue[expression.name.getText()] ?? null;
    return null;
  }
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = resolveExpression(expression.left, site);
    const right = resolveExpression(expression.right, site);
    if (left !== null && right !== null) return String(left) + String(right);
    return null;
  }
  return null;
}

function sourceFilesForLinks() {
  const files = [];
  try {
    if (statSync(DOCS_DIR).isDirectory()) files.push(...walkFiles(DOCS_DIR, (file) => file.endsWith(".tsx") || file.endsWith(".ts")));
  } catch {}
  try {
    if (statSync(CHANGELOG_PAGE).isFile()) files.push(CHANGELOG_PAGE);
  } catch {}
  return files.sort();
}

export async function collectLinks() {
  const site = await readSite();
  const siteUrl = new URL(site.SITE_URL);
  const files = sourceFilesForLinks();
  const links = [];
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const route = fileToRoute(file);
    function visit(node) {
      if (ts.isJsxAttribute(node) && node.name.getText(sourceFile) === "href" && node.initializer) {
        let expression = null;
        if (ts.isStringLiteral(node.initializer)) expression = node.initializer;
        else if (ts.isJsxExpression(node.initializer)) expression = node.initializer.expression;
        const resolved = resolveExpression(expression, site);
        links.push({ file, route, resolved, raw: node.initializer.getText(sourceFile) });
      }
      ts.forEachChild(node, visit);
    }
    visit(sourceFile);
  }
  for (const link of links) {
    if (link.resolved === null) continue;
    try {
      const url = new URL(link.resolved);
      link.sameOrigin = url.origin === siteUrl.origin;
    } catch {
      link.sameOrigin = false;
    }
  }
  return links;
}

function isInternalLink(href, link) {
  if (href.startsWith("/")) return true;
  if (href.startsWith("#")) return true;
  if (link.sameOrigin) return true;
  return false;
}

function splitHref(href) {
  const hashIndex = href.indexOf("#");
  if (hashIndex === -1) return { path: href, hash: "" };
  return { path: href.slice(0, hashIndex), hash: href.slice(hashIndex + 1) };
}

function normalizePath(pathname) {
  if (pathname === "") return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) return pathname.slice(0, -1);
  return pathname;
}

function pathToInternalPath(href, link) {
  if (href.startsWith("#")) return { path: link.route, hash: href.slice(1) };
  if (href.startsWith("/")) {
    const { path: pathPart, hash } = splitHref(href);
    return { path: normalizePath(pathPart), hash };
  }
  const url = new URL(href);
  const { path: pathPart, hash } = splitHref(url.pathname + (url.hash || ""));
  const finalHash = url.hash ? url.hash.slice(1) : hash;
  return { path: normalizePath(pathPart || "/"), hash: finalHash };
}

function routeMatches(routes, candidate) {
  for (const route of routes) {
    if (route === candidate) return true;
    const routeSegments = route.split("/").filter(Boolean);
    const candidateSegments = candidate.split("/").filter(Boolean);
    if (routeSegments.length !== candidateSegments.length) continue;
    if (routeSegments.every((segment, index) => (segment.startsWith("[") && segment.endsWith("]")) || segment === candidateSegments[index])) return true;
  }
  return false;
}

export async function check() {
  const { routes, anchorsByRoute } = collectRoutes();
  const links = await collectLinks();
  const problems = [];
  for (const link of links) {
    if (link.resolved === null) {
      problems.push(link.file + ": could not resolve href " + link.raw);
      continue;
    }
    const href = link.resolved;
    if (href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    if (isInternalLink(href, link)) {
      let pathPart;
      let hash;
      try {
        ({ path: pathPart, hash } = pathToInternalPath(href, link));
      } catch {
        problems.push(link.file + ": invalid internal link " + href);
        continue;
      }
      if (!routeMatches(routes, pathPart)) {
        problems.push(link.file + ": internal link does not resolve to a route: " + href);
        continue;
      }
      if (hash) {
        let anchorSet = null;
        for (const route of routes) {
          if (routeMatches([route], pathPart)) {
            anchorSet = anchorsByRoute.get(route) ?? new Set();
            break;
          }
        }
        if (!anchorSet) anchorSet = new Set();
        if (!anchorSet.has(hash)) {
          problems.push(link.file + ": anchor #" + hash + " does not resolve on " + pathPart);
        }
      }
    } else {
      if (!/^https:\/\//i.test(href)) problems.push(link.file + ": external link is not https: " + href);
    }
  }
  if (problems.length > 0) {
    console.error("check-links: " + problems.length + " problem" + (problems.length === 1 ? "" : "s"));
    for (const problem of problems) console.error("  " + problem);
    process.exitCode = 1;
    return { ok: false, problems, count: links.length };
  }
  console.log("check-links: " + links.length + " links checked, all resolve");
  return { ok: true, problems: [], count: links.length };
}

export default check;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await check();
  if (process.exitCode) process.exit(process.exitCode);
}
