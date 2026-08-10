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

const UNSTATED: CellValue = { word: "Unstated", affirmative: false };

/** The registry's three support values, in the words the page uses. */
const SUPPORT_WORD: Record<string, CellValue> = {
  implemented: { word: "Ready", affirmative: true },
  not_required: { word: "Not required", affirmative: false },
  absent: { word: "None", affirmative: false },
};

/**
 * The registry's verification vocabulary.
 *
 * Only `verified` is affirmative, and nothing in the registry is verified
 * today. Every other value is a state on the way there and is drawn quiet.
 */
const VERIFICATION_WORD: Record<string, CellValue> = {
  unverified: { word: "Unverified", affirmative: false },
  beta: { word: "Beta", affirmative: false },
  verified: { word: "Verified", affirmative: true },
  import_only: { word: "Import only", affirmative: false },
  manual: { word: "Manual", affirmative: false },
  experimental: { word: "Experimental", affirmative: false },
  planned: { word: "Planned", affirmative: false },
};

/**
 * A value the registry emitted that this page has no word for.
 *
 * It can only happen if the spec schema grows a value and this file is not
 * taught it, and the honest rendering of that is the raw code rather than a
 * guess at which of the existing words it resembles.
 */
function cellFor(table: Record<string, CellValue>, value: string): CellValue {
  return table[value] ?? { word: value, affirmative: false };
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
function stateOf(entry: RegistryEntry | undefined): string {
  if (entry === undefined) return "No spec";
  /* A product whose only reader is the person typing is Manual whether or not
     anything is implemented, because there is nothing for a reader to do. */
  if (entry.readers.every((reader) => reader === "manual")) return "Manual";
  if (entry.support.reader !== "implemented") return "Import only";
  if (entry.readers.some((reader) => LOCAL_READERS.has(reader))) return "Local CLI";
  return "Connected";
}

/**
 * What the reader column means in practice, in one line.
 *
 * Derived rather than written, because the previous version of this sentence
 * carried the support claim a second time ("Nothing here requests it") and
 * would have had to be found and edited on the day that stopped being true.
 */
function readerLine(entry: RegistryEntry | undefined): string {
  if (entry === undefined) {
    return "No reviewed spec in the registry yet, so nothing here claims a state for it.";
  }
  return entry.support.reader === "implemented"
    ? "OpenLimiter reads this one itself."
    : "Nothing here fetches it, so the document comes from you.";
}

/* --------------------------------------------------------------- the layout */

/**
 * Name, logo, and one fact about the provider.
 *
 * Nothing in this list is a support level, a state or a stage. It is what the
 * registry cannot carry: which artwork a row wears and what the provider itself
 * does. `specId` is the only link between the two, and a row whose id is not in
 * the registry renders as unstated rather than as anything invented.
 */
interface Presentation {
  specId: string;
  name: string;
  Mark: (props: ToolMarkProps) => React.ReactNode;
  fact: string;
}

const PRESENTATION: readonly Presentation[] = [
  {
    specId: "anthropic/claude-code",
    name: "Claude",
    Mark: ClaudeMark,
    fact: "Claude Code writes a rate limit block to its statusline command.",
  },
  {
    specId: "openrouter/api",
    name: "OpenRouter",
    Mark: OpenRouterMark,
    fact: "The credits endpoint is documented and its response parses.",
  },
  {
    specId: "openai/codex",
    name: "Codex",
    Mark: CodexMark,
    fact: "An internal payload shape, which can change without notice.",
  },
  {
    specId: "google/antigravity",
    name: "Antigravity",
    Mark: GoogleMark,
    fact: "An internal payload shape, which can change without notice.",
  },
  {
    specId: "opencode/opencode",
    name: "OpenCode",
    Mark: OpenCodeMark,
    fact: "A usage view behind a session you already hold.",
  },
  {
    specId: "openlimiter/manual",
    name: "Manual entry",
    Mark: ManualMark,
    fact: "Numbers you keep yourself, for anything with no interface.",
  },
];

interface Row {
  key: string;
  name: string;
  Mark: (props: ToolMarkProps) => React.ReactNode;
  fact: string;
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
  fact: presented.fact,
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

const COLUMNS = ["Parser", "Reader", "Auth", "Verification"] as const;

/**
 * A row's four stages, resolved once.
 *
 * Both layouts below read this, so the narrow one and the wide one cannot
 * disagree about a cell: there is one derivation and two ways of drawing it.
 */
function stagesOf(entry: RegistryEntry | undefined): readonly CellValue[] {
  if (entry === undefined) return [UNSTATED, UNSTATED, UNSTATED, UNSTATED];
  return [
    cellFor(SUPPORT_WORD, entry.support.parser),
    cellFor(SUPPORT_WORD, entry.support.reader),
    cellFor(SUPPORT_WORD, entry.support.auth),
    cellFor(VERIFICATION_WORD, entry.support.verification),
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
  const stages = stagesOf(row.entry);
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
          {stateOf(row.entry)}
        </Chip>
      </div>

      {/* Four across, in the reading order the columns had. They fit because
          the words are short and the labels are 11 pixel mono: stacking them
          two by two doubled the card's height for no gain. */}
      <dl className="mt-3 grid grid-cols-4 gap-x-2 border-t border-hairline pt-3">
        {COLUMNS.map((column, index) => (
          <div key={column} className="flex min-w-0 flex-col gap-0.5">
            <dt className="font-mono text-2xs uppercase tracking-wider text-muted">
              {column}
            </dt>
            <dd className="leading-tight">
              <Cell value={stages[index] ?? UNSTATED} />
            </dd>
          </div>
        ))}
      </dl>

      {/* The provider fact only. The reader sentence the table carries would
          repeat what the Reader cell two lines above already says. */}
      <p className="mt-3 text-xs leading-relaxed text-muted">{row.fact}</p>
    </li>
  );
}

export function ConnectionMatrix() {
  return (
    <div className="mt-10" {...reveal}>
      <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-mono text-2xs uppercase tracking-widest text-heading">
          What each one actually does
        </h3>
        <span aria-hidden="true" className="hidden h-px flex-1 bg-hairline sm:block" />
        <p className="w-full text-xs text-muted sm:w-auto">
          A parser is not a connection
        </p>
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
          <caption className="sr-only">
            Every provider, and which of the four stages of support it has
            reached today, read from the reviewed provider registry
          </caption>
          <thead>
            <tr className="border-b border-hairline">
              <th
                scope="col"
                className="px-5 py-3 font-mono text-2xs font-normal uppercase tracking-widest text-muted"
              >
                Provider
              </th>
              <th
                scope="col"
                className="px-5 py-3 font-mono text-2xs font-normal uppercase tracking-widest text-muted"
              >
                State
              </th>
              {COLUMNS.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className="px-5 py-3 font-mono text-2xs font-normal uppercase tracking-widest text-muted"
                >
                  {column}
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
                    {row.fact} {readerLine(row.entry)}
                  </span>
                </th>
                <td className="px-5 py-3.5 align-top">
                  <Chip tone="neutral" className="whitespace-nowrap">
                    {stateOf(row.entry)}
                  </Chip>
                </td>
                {/* Parser, Reader, Auth, then the registry's own verification
                    status, which is the only place a human records that a shape
                    was confirmed against a live account. Nothing here can raise
                    any of the four. */}
                {stagesOf(row.entry).map((stage, index) => (
                  <td key={COLUMNS[index]} className="px-5 py-3.5 align-top">
                    <Cell value={stage} />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
        Reader means something in OpenLimiter goes and fetches the number. Auth
        means a credential is held and used. Every cell above is read at build
        time from the reviewed provider registry rather than written into this
        page, so a stage cannot be claimed here without a human changing a spec
        first.{" "}
        {unspecified > 0 && (
          <>
            {unspecified} of the {rows.length} connectors have no reviewed spec
            yet, and every one of their cells reads Unstated rather than
            guessing.{" "}
          </>
        )}
        {elsewhere > 0 && (
          <>
            The registry describes {elsewhere} further products with no connector
            at all, which is why they are not rows here.{" "}
          </>
        )}
        Nothing on this page is called connected.
      </p>
    </div>
  );
}
