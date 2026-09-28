import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve through the site's dependency chain so pnpm's isolated installs use
// exactly the parser used by next-intl, rather than a separately pinned copy.
const webRequire = createRequire(new URL("../apps/web/package.json", import.meta.url));
const intlRequire = createRequire(webRequire.resolve("next-intl"));
const useIntlRequire = createRequire(intlRequire.resolve("use-intl"));
const formatRequire = createRequire(useIntlRequire.resolve("intl-messageformat"));
const { parse } = formatRequire("@formatjs/icu-messageformat-parser");

function checkMessages(value, location, failures) {
  if (typeof value === "string") {
    try {
      parse(value);
    } catch (error) {
      failures.push(`${location}: ${error.message}`);
    }
    return 1;
  }
  if (value !== null && typeof value === "object") {
    return Object.entries(value).reduce(
      (count, [key, child]) => count + checkMessages(child, `${location}.${key}`, failures),
      0
    );
  }
  failures.push(`${location}: expected a message string or nested messages`);
  return 0;
}

async function checkCatalogs(directory) {
  const failures = [];
  let catalogs = 0;
  let strings = 0;
  for (const entry of await readdir(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(entry.parentPath, entry.name);
    const label = path.relative(directory, file);
    catalogs += 1;
    try {
      strings += checkMessages(JSON.parse(await readFile(file, "utf8")), label, failures);
    } catch (error) {
      failures.push(`${label}: ${error.message}`);
    }
  }
  if (catalogs === 0) failures.push("No locale catalogs found");
  if (failures.length > 0) throw new Error(failures.join("\n"));
  console.log(`Catalog ICU check passed: ${strings} strings in ${catalogs} catalogs`);
}

if (process.argv[2] === "--self-test") {
  const { test } = await import("node:test");
  test("accepts ICU arguments, plurals, select, rich text and escaped braces", () => {
    const failures = [];
    assert.equal(checkMessages({ nested: [
      "Hello {name}",
      "{count, plural, =0 {None} one {# item} other {# items}}",
      "{kind, select, a {A} other {Other}}",
      "<strong>Read {name}</strong>",
      "Use '{placeholder}'"
    ] }, "fixture.json", failures), 5);
    assert.deepEqual(failures, []);
  });
  test("rejects broken ICU strings with the catalog and nested key", () => {
    for (const message of ["Broken {placeholder", "{n, plural, one {One}}", "<strong>Unclosed"]) {
      const failures = [];
      checkMessages({ nested: { broken: message } }, "fixture.json", failures);
      assert.equal(failures.length, 1);
      assert.match(failures[0], /^fixture\.json\.nested\.broken: /);
    }
  });
  test("the catalog gate fails for a deliberately broken locale file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "openlimiter-catalog-test-"));
    try {
      await writeFile(path.join(directory, "broken.json"), JSON.stringify({
        nested: { placeholder: "Broken {placeholder" }
      }));
      await assert.rejects(checkCatalogs(directory), /broken\.json\.nested\.placeholder:/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
} else {
  try {
    await checkCatalogs(fileURLToPath(new URL("../apps/web/messages/", import.meta.url)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
