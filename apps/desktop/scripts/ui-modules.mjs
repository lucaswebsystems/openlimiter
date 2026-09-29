import ts from "typescript";

/** Parse imports instead of matching text inside comments, strings or templates. */
export function moduleReferences(source, filename = "module.js") {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const references = [];
  const literal = node => node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));
  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && literal(node.moduleSpecifier)) {
      references.push({ specifier: node.moduleSpecifier.text,
        start: node.moduleSpecifier.getStart(file), end: node.moduleSpecifier.end,
        removeStart: node.attributes ? node.moduleSpecifier.end : undefined, removeEnd: node.attributes?.end });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && literal(node.arguments[0])) {
      const specifier = node.arguments[0];
      references.push({ specifier: specifier.text, start: specifier.getStart(file), end: specifier.end,
        removeStart: node.arguments.length > 1 ? specifier.end : undefined,
        removeEnd: node.arguments.length > 1 ? node.arguments.at(-1).end : undefined });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return references;
}

export function rewriteJsonImports(source, resolve, filename) {
  const edits = [];
  for (const ref of moduleReferences(source, filename)) {
    if (!/\.json(?:[?#]|$)/iu.test(ref.specifier)) continue;
    edits.push({ start: ref.start, end: ref.end, text: JSON.stringify(resolve(ref.specifier)) });
    if (ref.removeStart !== undefined) edits.push({ start: ref.removeStart, end: ref.removeEnd, text: "" });
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  }
  return source;
}

export function htmlScripts(html) {
  return [...html.replace(/<!--[\s\S]*?-->/gu, "").matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu)]
    .map(([, attributes, source]) => ({ attributes, source,
      src: /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu.exec(attributes)?.slice(1).find(value => value !== undefined) }));
}
