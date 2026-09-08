/** A lossless TOML syntax tree. Unchanged values and comments retain their bytes.
 * Values are parsed recursively, so strings, arrays and inline tables cannot
 * masquerade as assignments or table headers during an edit. */
type Value = string | number | boolean | null | Value[] | { [key: string]: Value };
interface Entry { keys: string[]; start: number; end: number; value: Value }
interface Table { keys: string[]; insert: number; array: boolean }
const same = (a: string[], b: string[]): boolean => JSON.stringify(a) === JSON.stringify(b);

class Parser {
  i = 0;
  entries: Entry[] = [];
  tables: Table[] = [];
  constructor(readonly text: string) {}
  fail(): never { throw new Error("Invalid TOML"); }
  peek(): string { return this.text[this.i] ?? ""; }
  spaces(multiline = false): void {
    while (this.i < this.text.length) {
      if (/[ \t]/.test(this.peek()) || (multiline && /[\r\n]/.test(this.peek()))) this.i++;
      else if (multiline && this.peek() === "#") this.comment();
      else break;
    }
  }
  comment(): void {
    while (this.i < this.text.length && this.peek() !== "\n") this.i++;
  }
  string(key = false): string {
    const quote = this.peek();
    const triple = !key && this.text.slice(this.i, this.i + 3) === quote.repeat(3);
    this.i += triple ? 3 : 1;
    if (triple && this.text.slice(this.i, this.i + 2) === "\r\n") this.i += 2;
    else if (triple && this.peek() === "\n") this.i++;
    let result = "";
    while (this.i < this.text.length) {
      if (this.peek() === quote) {
        if (!triple) { this.i++; return result; }
        if (this.text.slice(this.i, this.i + 3) === quote.repeat(3)) {
          this.i += 3;
          for (let n = 0; n < 2 && this.peek() === quote; n++, this.i++) result += quote;
          return result;
        }
      }
      const c = this.text[this.i++]!;
      if ((!triple && /[\r\n]/.test(c)) || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c)) this.fail();
      if (c !== "\\" || quote === "'") { result += c; continue; }
      if (triple && /[ \t\r\n]/.test(this.peek())) {
        const start = this.i;
        while (this.i < this.text.length && /\s/.test(this.peek())) this.i++;
        if (!this.text.slice(start, this.i).includes("\n")) this.fail();
        continue;
      }
      const escape = this.text[this.i++] ?? "";
      const escapes: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
      if (escape in escapes) result += escapes[escape];
      else if (escape === "u" || escape === "U") {
        const size = escape === "u" ? 4 : 8;
        const hex = this.text.slice(this.i, this.i + size);
        if (hex.length !== size || !/^[0-9a-f]+$/i.test(hex)) this.fail();
        const point = Number.parseInt(hex, 16);
        if (point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) this.fail();
        result += String.fromCodePoint(point);
        this.i += size;
      } else this.fail();
    }
    return this.fail();
  }
  keys(): string[] {
    const keys: string[] = [];
    do {
      this.spaces();
      if (this.peek() === '"' || this.peek() === "'") keys.push(this.string(true));
      else {
        const start = this.i;
        while (this.i < this.text.length && /[A-Za-z0-9_-]/.test(this.peek())) this.i++;
        if (this.i === start) this.fail();
        keys.push(this.text.slice(start, this.i));
      }
      this.spaces();
      if (this.peek() !== ".") return keys;
      this.i++;
    } while (this.i < this.text.length);
    return this.fail();
  }
  value(depth = 0): Value {
    if (depth > 100) this.fail();
    this.spaces();
    if (this.peek() === '"' || this.peek() === "'") return this.string();
    if (this.peek() === "[") {
      this.i++;
      const values: Value[] = [];
      this.spaces(true);
      while (this.peek() !== "]") {
        values.push(this.value(depth + 1));
        this.spaces(true);
        if (this.peek() !== ",") break;
        this.i++; this.spaces(true);
      }
      if (this.peek() !== "]") this.fail();
      this.i++;
      return values;
    }
    if (this.peek() === "{") {
      this.i++;
      const result: { [key: string]: Value } = Object.create(null);
      const assigned: string[][] = [];
      this.spaces();
      while (this.peek() !== "}") {
        const keys = this.keys();
        if (assigned.some(k => same(k.slice(0, keys.length), keys) || same(keys.slice(0, k.length), k))) this.fail();
        assigned.push(keys);
        if (this.peek() !== "=") this.fail();
        this.i++;
        result[JSON.stringify(keys)] = this.value(depth + 1);
        this.spaces();
        if (this.peek() !== ",") break;
        this.i++; this.spaces();
        if (this.peek() === "}") this.fail();
      }
      if (this.peek() !== "}") this.fail();
      this.i++;
      return result;
    }
    const start = this.i;
    while (this.i < this.text.length && !/[\r\n,#\]}]/.test(this.peek())) this.i++;
    const raw = this.text.slice(start, this.i).trim();
    if (raw === "true" || raw === "false") return raw === "true";
    if (/^[+-]?(inf|nan)$/.test(raw)) return null;
    if (/^[+-]?(0|[1-9](?:_?[0-9])*)(\.[0-9](?:_?[0-9])*)?([eE][+-]?[0-9](?:_?[0-9])*)?$/.test(raw) ||
        /^0(x[0-9a-fA-F](?:_?[0-9a-fA-F])*|o[0-7](?:_?[0-7])*|b[01](?:_?[01])*)$/.test(raw)) return Number(raw.replaceAll("_", ""));
    if (/^(\d{4}-\d{2}-\d{2}([Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})?)?|\d{2}:\d{2}:\d{2}(\.\d+)?)$/.test(raw)) {
      const date = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
      if (date) {
        const year = Number(date[1]), month = Number(date[2]), day = Number(date[3]);
        const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        if (month < 1 || month > 12 || day < 1 || day > days[month - 1]!) this.fail();
      }
      const time = /(\d{2}):(\d{2}):(\d{2})/.exec(raw);
      if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3]) > 60)) this.fail();
      const offset = /[+-](\d{2}):(\d{2})$/.exec(raw);
      if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) this.fail();
      return raw;
    }
    return this.fail();
  }
  parse(): this {
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(this.text) || /\r(?!\n)/.test(this.text)) this.fail();
    let section: string[] = [], scope: string[] = [];
    const values: string[][] = [], tables = new Set<string>(), dotted = new Set<string>(), arrays = new Map<string, number>();
    while (this.i < this.text.length) {
      this.spaces(true);
      if (this.i === this.text.length) break;
      if (this.peek() === "[") {
        this.i++;
        const array = this.peek() === "[";
        if (array) this.i++;
        section = this.keys();
        if (this.peek() !== "]") this.fail();
        this.i++;
        if (array) { if (this.peek() !== "]") this.fail(); this.i++; }
        scope = [...section];
        for (let n = 1; n <= section.length; n++) {
          const id = JSON.stringify(section.slice(0, n));
          if (n === section.length && array) {
            if (!arrays.has(id) && (dotted.has(JSON.stringify(scope)) || tables.has(JSON.stringify(scope)) || values.some(k => same(scope.slice(0, k.length), k)))) this.fail();
            arrays.set(id, (arrays.get(id) ?? 0) + 1);
          }
          if (arrays.has(id)) scope[n - 1] += `\u0000${arrays.get(id)}`;
        }
        const id = JSON.stringify(scope);
        if (tables.has(id) || dotted.has(id) || values.some(k => same(scope.slice(0, k.length), k))) this.fail();
        tables.add(id);
        this.tables.push({ keys: section, insert: this.i, array: array || scope.some(k => k.includes("\u0000")) });
      } else {
        const keys = this.keys();
        const full = [...scope, ...keys];
        if (values.some(k => same(k.slice(0, full.length), full) || same(full.slice(0, k.length), k)) || tables.has(JSON.stringify(full))) this.fail();
        values.push(full);
        for (let n = scope.length + 1; n < full.length; n++) dotted.add(JSON.stringify(full.slice(0, n)));
        if (this.peek() !== "=") this.fail();
        this.i++; this.spaces();
        const start = this.i;
        const value = this.value();
        this.entries.push({ keys: [...section, ...keys], start, end: this.i, value });
      }
      this.spaces();
      if (this.peek() === "#") this.comment();
      if (this.peek() === "\r") this.i++;
      if (this.i < this.text.length && this.peek() !== "\n") this.fail();
      if (this.peek() === "\n") this.i++;
      const last = this.tables.at(-1);
      if (last) last.insert = this.i;
    }
    return this;
  }
}

export function parseToml(text: string): Parser { return new Parser(text).parse(); }
export function tomlValue(text: string, keys: string[]): Value | undefined {
  return parseToml(text).entries.find(e => same(e.keys, keys))?.value;
}

/** Serialize only changed scalar values, then parse the entire candidate. */
export function editToml(text: string, table: string[], settings: Record<string, Value>): string {
  const parsed = parseToml(text);
  if (parsed.tables.some(t => t.array && same(t.keys.slice(0, table.length), table))) throw new Error("Invalid TOML");
  const edits: { start: number; end: number; text: string }[] = [];
  const added: string[] = [];
  for (const [key, value] of Object.entries(settings)) {
    const entry = parsed.entries.find(e => same(e.keys, [...table, key]));
    const serialized = JSON.stringify(value);
    if (entry) edits.push({ start: entry.start, end: entry.end, text: serialized });
    else added.push(`${key} = ${serialized}`);
  }
  const existingTable = parsed.tables.find(t => same(t.keys, table));
  const insertion = existingTable?.insert ?? text.length;
  const content = existingTable ? added : [`[${table.join(".")}]`, ...added];
  edits.push({ start: insertion, end: insertion, text: `\n# openlimiter managed\n${content.join("\n")}\n` });
  let result = text;
  for (const edit of edits.sort((a, b) => b.start - a.start)) result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  parseToml(result);
  return result;
}
