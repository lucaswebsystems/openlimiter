import { useTranslations } from "next-intl";
import registry from "../lib/provider-specs.generated.json";
import {
  ClaudeMark,
  CodexMark,
  GoogleMark,
  ManualMark,
  OpenCodeMark,
  OpenRouterMark,
  type ToolMarkProps,
} from "./tool-marks";
import { Chip } from "./ui";
import { reveal } from "@/lib/motion";

/**
 * The support matrix, and it is deliberately the least exciting block on the
 * page.
 *
 * A visitor reading the section above this one sees six provider names, six
 * real logos and six cards that say `today`, and the reasonable conclusion is
 * that installing this connects six accounts. It does not. So the audit's four
 * concepts are four columns, stated separately, because collapsing them into
 * one word is exactly how `Connected` gets claimed on the strength of a parser
 * existing:
 *
 *   Parser        the shape is understood and validated
 *   Reader        something here goes and gets it
 *   Auth          a credential is held and used
 *   Verification  a human confirmed it against a live account
 *
 * EVERY CELL COMES OUT OF THE REGISTRY, AND NONE IS WRITTEN HERE
 * --------------------------------------------------------------
 * The cells used to be four literals per row, typed into this file. That put
 * the product's most load bearing honesty claim in a marketing component, where
 * nothing checks it and nothing regenerates it: a reader could ship, or a
 * credential store could land, and this table would keep saying None until
 * somebody remembered it existed.
 *
 * So the truth is read, at build time, out of
 *
 *   lib/provider-specs.generated.json
 *
 * the app local mirror of `provider_specs/provider-specs.json`, which
 * `node scripts/validate-provider-specs.mjs --emit` generates from the
 * reviewed YAML entries and copies here in the same run. The mirror exists
 * because this app deploys standalone from `apps/web`, where a path above the
 * app root does not exist. The entries are validated on every test run, so a
 * cell below cannot disagree with the registry and cannot be edited without a
 * human editing a reviewed spec first. This component holds presentation only:
 * a name, a logo, and one sentence of provider fact that states no support
 * level at all.
 *
 * A PROVIDER WITH NO SPEC IS SHOWN AS HAVING NO SPEC
 * --------------------------------------------------
 * Four of the six connectors have no reviewed entry yet. Deriving the table
 * strictly from the registry would drop them off the page entirely, directly
 * under six tiles for the same six products, which trades one silent claim for
 * another. They keep their row, every cell reads Unstated, and the line under
 * the table counts them. The moment a spec lands for one, its row fills in here
 * with no edit to this file.
 *
 * The registry also describes products nobody has written a connector for. Those
 * are not rows: this table answers a question about the six above it. They are
 * counted in the same line, so the rest of the registry is disclosed rather than
 * quietly dropped.
 */

/** Shorthand for the translator this whole file threads through its helpers. */
type Translate = ReturnType<typeof useTranslations>;

/* ------------------------------------------------------------- the registry */

/**
 * The slice of a generated entry this table reads.
 *
 * Deliberately narrow. The emitted document carries meters, platforms, doc
 * URLs and review dates as well, and none of that belongs in a support matrix,
 * so nothing here can start depending on it by accident.
 */
interface RegistryEntry {
  readonly id: string;
  readonly displayName: string;
  readonly support: {
    readonly parser: string;
    readonly reader: string;
    readonly auth: string;
    readonly verification: string;
  };
  readonly readers: readonly string[];
}

const entries: readonly RegistryEntry[] = registry.providers;

const byId = new Map(entries.map((entry) => [entry.id, entry]));

/* ---------------------------------------------------------------- the words */

/**
 * How a cell reads, and how loudly.
 *
 * `affirmative` is the one thing the eye should catch: it means this stage is
 * genuinely reached. Everything else, including the absence of a spec, is
 * quiet, because a table where every cell shouts says nothing.
 */
interface CellValue {
  word: string;
  affirmative: boolean;
}

/**
 * A cell's loudness and its catalog key, kept apart from the word itself.
 *
 * The word only exists once translated, so these tables carry the catalog key
 * (`support.ready`, `verification.beta`, ...) and the loudness flag, and
 * `cellFor` resolves the two into the `CellValue` a cell actually renders.
 */
interface CellMeta {
  key: string;
  affirmative: boolean;
}

function unstatedCell(t: Translate): CellValue {
  return { word: t("cells.unstated"), affirmative: false };
}

/** The registry's three support values, in the catalog keys the page uses. */
const SUPPORT_META: Record<string, CellMeta> = {
  implemented: { key: "support.ready", affirmative: true },
  not_required: { key: "support.notRequired", affirmative: false },
  absent: { key: "support.none", affirmative: false },
};

/**
 * The registry's verification vocabulary.
 *
 * Only `verified` is affirmative, and nothing in the registry is verified
 * today. Every other value is a state on the way there and is drawn quiet.
 */
const VERIFICATION_META: Record<string, CellMeta> = {
  unverified: { key: "verification.unverified", affirmative: false },
  beta: { key: "verification.beta", affirmative: false },
  verified: { key: "verification.verified", affirmative: true },
  import_only: { key: "verification.importOnly", affirmative: false },
  manual: { key: "verification.manual", affirmative: false },
  experimental: { key: "verification.experimental", affirmative: false },
  planned: { key: "verification.planned", affirmative: false },
};

/**
 * A value the registry emitted that this page has no word for.
 *
 * It can only happen if the spec schema grows a value and this file is not
 * taught it, and the honest rendering of that is the raw code rather than a
 * guess at which of the existing words it resembles, so this one case stays
 * an untranslated literal on purpose.
 */
function cellFor(t: Translate, table: Record<string, CellMeta>, value: string): CellValue {
  const meta = table[value];
  return meta === undefined
    ? { word: value, affirmative: false }
    : { word: t(meta.key), affirmative: meta.affirmative };
}

/** Readers that run on the machine the person is already sitting at. */
const LOCAL_READERS = new Set([
  "statusline_payload",
  "local_event",
  "local_file",
  "local_command",
]);

/**
 * The one word state chip, in the same vocabulary the application's cards use.
 *
 * Derived from the reader, never from the parser, which is the whole point of
 * keeping the two columns apart. A product with no reader is an import however
 * complete its parser is.
 */
function stateOf(t: Translate, entry: RegistryEntry | undefined): string {
  if (entry === undefined) return t("state.noSpec");
  /* A product whose only reader is the person typing is Manual whether or not
     anything is implemented, because there is nothing for a reader to do. */
  if (entry.readers.every((reader) => reader === "manual")) return t("state.manual");
  if (entry.support.reader !== "implemented") return t("state.importOnly");
  if (entry.readers.some((reader) => LOCAL_READERS.has(reader))) return t("state.localCli");
  return t("state.connected");
}

/**
 * What the reader column means in practice, in one line.
 *
 * Derived rather than written, because the previous version of this sentence
 * carried the support claim a second time ("Nothing here requests it") and
 * would have had to be found and edited on the day that stopped being true.
 */
function readerLine(t: Translate, entry: RegistryEntry | undefined): string {
  if (entry === undefined) {
    return t("readerLine.noSpec");
  }
  return entry.support.reader === "implemented"
    ? t("readerLine.implemented")
    : t("readerLine.notImplemented");
}

/* --------------------------------------------------------------- the layout */

/**
 * Name, logo, and the catalog key for one fact about the provider.
 *
 * Nothing in this list is a support level, a state or a stage. It is what the
 * registry cannot carry: which artwork a row wears and what the provider itself
 * does. `specId` is the only link between the two, and a row whose id is not in
 * the registry renders as unstated rather than as anything invented. The fact
 * sentence itself lives in the message catalog under `providers.<factKey>.fact`,
 * so this file carries only the pointer to it.
 */
interface Presentation {
  specId: string;
  name: string;
  Mark: (props: ToolMarkProps) => React.ReactNode;
  factKey: string;
}

const PRESENTATION: readonly Presentation[] = [
  {
    specId: "anthropic/claude-code",
    name: "Claude",
    Mark: ClaudeMark,
    factKey: "claude",
  },
  {
    specId: "openrouter/api",
    name: "OpenRouter",
    Mark: OpenRouterMark,
    factKey: "openrouter",
  },
  {
    specId: "openai/codex",
    name: "Codex",
    Mark: CodexMark,
    factKey: "codex",
  },
  {
    specId: "google/antigravity",
    name: "Antigravity",
    Mark: GoogleMark,
    factKey: "antigravity",
  },
  {
    specId: "opencode/opencode",
    name: "OpenCode",
    Mark: OpenCodeMark,
    factKey: "opencode",
  },
  {
    specId: "openlimiter/manual",
    name: "Manual entry",
    Mark: ManualMark,
    factKey: "manual",
  },
];

interface Row {
  key: string;
  name: string;
  Mark: (props: ToolMarkProps) => React.ReactNode;
  factKey: string;
  entry: RegistryEntry | undefined;
}

/**
 * The rows, which are the six this section is about and no others.
 *
 * The registry describes more products than these, because it also records
 * providers nobody has written a connector for, and those belong on the
 * documentation's provider page rather than in a table that sits directly under
 * six tiles and answers the question "what do those six actually do". They are
 * counted in the line under the table instead, so the rest of the registry is
 * disclosed without being rendered.
 */
const rows: readonly Row[] = PRESENTATION.map((presented) => ({
  key: presented.specId,
  name: presented.name,
  Mark: presented.Mark,
  factKey: presented.factKey,
  entry: byId.get(presented.specId),
}));

const unspecified = rows.filter((row) => row.entry === undefined).length;

/** Registry entries this table does not draw, which is every planned product. */
const elsewhere = entries.filter(
  (entry) => !PRESENTATION.some((presented) => presented.specId === entry.id),
).length;

function Cell({ value }: { value: CellValue }) {
  return (
    <span
      className={`font-mono text-2xs uppercase tracking-wider ${
        value.affirmative ? "text-heading" : "text-muted"
      }`}
    >
      {value.word}
    </span>
  );
}

/** Stable, untranslated keys. The header labels come from the catalog. */
const COLUMN_KEYS = ["parser", "reader", "auth", "verification"] as const;

/**
 * A row's four stages, resolved once.
 *
 * Both layouts below read this, so the narrow one and the wide one cannot
 * disagree about a cell: there is one derivation and two ways of drawing it.
 */
function stagesOf(t: Translate, entry: RegistryEntry | undefined): readonly CellValue[] {
  if (entry === undefined) {
    const unstated = unstatedCell(t);
    return [unstated, unstated, unstated, unstated];
  }
  return [
    cellFor(t, SUPPORT_META, entry.support.parser),
    cellFor(t, SUPPORT_META, entry.support.reader),
    cellFor(t, SUPPORT_META, entry.support.auth),
    cellFor(t, VERIFICATION_META, entry.support.verification),
  ];
}

/**
 * The narrow layout, and why the table does not simply scroll.
 *
 * A six column table inside a horizontal scroller reads badly on a phone: the
 * provider sentence wraps in a column a third of the screen wide, which pushed
 * rows past 170 pixels tall, and all four stage cells sat off screen, so a
 * visitor scrolling the page saw a name and a chip and nothing that this block
 * exists to say. The same data as a card puts the four stages on screen with
 * their own labels, in the reading order the columns had.
 */
function StageCard({ row }: { row: Row }) {
  const t = useTranslations("connections");
  const stages = stagesOf(t, row.entry);
  const fallback = unstatedCell(t);
  const columns = COLUMN_KEYS.map((key) => ({ key, label: t(`columns.${key}`) }));
  return (
    <li className="rounded-xl border border-hairline bg-surface p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="flex min-w-0 items-center gap-2.5">
          <span className="flex-none text-soft">
            <row.Mark className="h-4 w-4" />
          </span>
          <span className="heading-face truncate text-sm text-heading">{row.name}</span>
        </span>
        <Chip tone="neutral" className="flex-none whitespace-nowrap">
          {stateOf(t, row.entry)}
        </Chip>
      </div>

      {/* Four across, in the reading order the columns had. They fit because
          the words are short and the labels are 11 pixel mono: stacking them
          two by two doubled the card's height for no gain. */}
      <dl className="mt-3 grid grid-cols-4 gap-x-2 border-t border-hairline pt-3">
        {columns.map((column, index) => (
          <div key={column.key} className="flex min-w-0 flex-col gap-0.5">
            <dt className="font-mono text-2xs uppercase tracking-wider text-muted">
              {column.label}
            </dt>
            <dd className="leading-tight">
              <Cell value={stages[index] ?? fallback} />
            </dd>
          </div>
        ))}
      </dl>

      {/* The provider fact only. The reader sentence the table carries would
          repeat what the Reader cell two lines above already says. */}
      <p className="mt-3 text-xs leading-relaxed text-muted">
        {t(`providers.${row.factKey}.fact`)}
      </p>
    </li>
  );
}

export function ConnectionMatrix() {
  const t = useTranslations("connections");
  const columns = COLUMN_KEYS.map((key) => ({ key, label: t(`columns.${key}`) }));

  return (
    <div className="mt-10" {...reveal}>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-mono text-2xs uppercase tracking-widest text-heading">
          {t("heading.title")}
        </h3>
        <span aria-hidden="true" className="hidden h-px flex-1 bg-hairline sm:block" />
        <p className="w-full text-xs text-muted sm:w-auto">{t("heading.note")}</p>
      </div>

      {/* One card per provider below the medium breakpoint. Same data, same
          derivation, laid out so all four stages are on the screen. */}
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:hidden">
        {rows.map((row) => (
          <StageCard key={row.key} row={row} />
        ))}
      </ul>

      {/* The table, from the medium breakpoint up, where six columns fit. It
          still scrolls inside its own box rather than pushing the document
          sideways on the widths in between. */}
      <div className="hidden overflow-x-auto rounded-xl border border-hairline bg-surface md:block">
        <table className="w-full min-w-[44rem] border-collapse text-left">
          <caption className="sr-only">{t("table.caption")}</caption>
          <thead>
            <tr className="border-b border-hairline">
              <th
                scope="col"
                className="px-5 py-3 font-mono text-2xs font-normal uppercase tracking-widest text-muted"
              >
                {t("table.provider")}
              </th>
              <th
                scope="col"
                className="px-5 py-3 font-mono text-2xs font-normal uppercase tracking-widest text-muted"
              >
                {t("table.state")}
              </th>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className="px-5 py-3 font-mono text-2xs font-normal uppercase tracking-widest text-muted"
                >
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-hairline last:border-b-0">
                <th scope="row" className="px-5 py-3.5 font-normal">
                  <span className="flex items-center gap-2.5">
                    <span className="text-soft">
                      <row.Mark className="h-4 w-4" />
                    </span>
                    <span className="heading-face text-sm text-heading">{row.name}</span>
                  </span>
                  <span className="mt-1 block text-xs leading-relaxed text-muted">
                    {t(`providers.${row.factKey}.fact`)} {readerLine(t, row.entry)}
                  </span>
                </th>
                <td className="px-5 py-3.5 align-top">
                  <Chip tone="neutral" className="whitespace-nowrap">
                    {stateOf(t, row.entry)}
                  </Chip>
                </td>
                {/* Parser, Reader, Auth, then the registry's own verification
                    status, which is the only place a human records that a shape
                    was confirmed against a live account. Nothing here can raise
                    any of the four. */}
                {stagesOf(t, row.entry).map((stage, index) => (
                  <td key={COLUMN_KEYS[index]} className="px-5 py-3.5 align-top">
                    <Cell value={stage} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Full container width, matching the table and the card grid above it.
          Capped at a 70ch measure this note sat as a narrow column under a full
          width block and read as a different, smaller page. */}
      <p className="mt-4 w-full text-center text-sm leading-relaxed text-muted">
        {t("footnote.lead")}{" "}
        {unspecified > 0 && (
          <>
            {t("footnote.unspecified", { count: unspecified, total: rows.length })}{" "}
          </>
        )}
        {elsewhere > 0 && (
          <>
            {t("footnote.elsewhere", { count: elsewhere })}{" "}
          </>
        )}
        {t("footnote.tail")}
      </p>
    </div>
  );
}
