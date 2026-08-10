import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, DocLink, P, Sub, Table } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";

export const metadata: Metadata = docMetadata("/docs/connections");

/**
 * Source chip vocabulary: what the dashboard actually renders today.
 *
 * Quoted, not imported, from apps/web/app/app/language.ts: `sourceStateLabel`
 * for the chip word and `sourceStateSentence` for the meaning. That module
 * sits inside the dashboard's own module graph and is out of scope for this
 * page to depend on. If this table and language.ts ever disagree, language.ts
 * is right and this table is the bug.
 */
const SOURCE_CHIPS = [
  {
    chip: "Local CLI",
    providers: "Claude",
    meaning: "A tool on this machine writes the payload, and OpenLimiter reads what it wrote.",
  },
  {
    chip: "Import only",
    providers: "OpenRouter, Codex, Antigravity, OpenCode",
    meaning: "The payload shape is parsed. Nothing here signs in or fetches it, so you supply the document.",
  },
  {
    chip: "Manual",
    providers: "Manual entries",
    meaning: "Figures you keep yourself. Nothing is read from an account.",
  },
] as const;

/**
 * The full connection vocabulary, quoted rather than imported.
 *
 * Source of truth: packages/core/src/connection-state.ts, export
 * `connectionSentence`. apps/web is deployed on its own and is not a member of
 * the pnpm workspace (see apps/web/app/app/engine/sync.mjs), so it cannot
 * import "@openlimiter/core" as a package. The browser mirror that works
 * around that for the dashboard, apps/web/app/app/engine/generated/core/
 * connection-state.ts, is generated for that dashboard specifically and is out
 * of scope for a docs page to depend on. If this table and the core module
 * ever disagree, the core module is right and this table is the bug: diff
 * against connectionSentence to fix it.
 */
const CONNECTION_STATE_ROWS = [
  { state: "NOT_CONFIGURED", sentence: "Not connected." },
  { state: "DETECTED", sentence: "Found on this machine but not collecting yet." },
  { state: "NEEDS_AUTH", sentence: "Waiting for a credential." },
  { state: "READY_TO_ENABLE", sentence: "Ready to start collecting." },
  { state: "CONNECTING", sentence: "Connecting." },
  { state: "CONNECTED", sentence: "Connected and collecting." },
  { state: "DEGRADED", sentence: "The provider is refusing reads for now." },
  { state: "STALE", sentence: "The last reading is older than it should be." },
  { state: "AUTH_EXPIRED", sentence: "The stored credential stopped working." },
  {
    state: "IMPORT_ONLY",
    sentence: "Reads only what you import. Nothing is collected automatically.",
  },
  { state: "MANUAL", sentence: "Shows the plan you entered yourself." },
  { state: "UNSUPPORTED", sentence: "No safe automatic source exists for this product yet." },
  { state: "ERROR", sentence: "This connection failed and needs a look." },
] as const;

export default function ConnectionsPage() {
  return (
    <DocArticle
      href="/docs/connections"
      title="Connections"
      lead="Every provider shows two things: a chip naming where its numbers came from, and, underneath, a state drawn from one vocabulary the whole product shares. This page names every state in it, says plainly what Import only means, and says what changes once a live connection exists."
      sections={[
        {
          id: "chips",
          title: "The chip on a provider today",
          body: (
            <>
              <P>
                A parser existing is not a connection, so no card in the dashboard is ever
                labelled connected on the strength of one. Every provider instead carries a chip
                naming how its numbers actually reached this device. There are three, today.
              </P>
              <Table
                caption="The three source chips shown in the dashboard today"
                columns={[
                  { key: "chip", header: "chip" },
                  { key: "providers", header: "providers" },
                  { key: "meaning", header: "meaning" },
                ]}
                rows={SOURCE_CHIPS.map((row) => ({
                  chip: <Code>{row.chip}</Code>,
                  providers: row.providers,
                  meaning: row.meaning,
                }))}
              />
              <Callout tone="key" title="What Import only actually means">
                A parser exists for that provider&apos;s document, and OpenLimiter understands the
                shape when it sees one. Nothing here signs in, holds a key, or fetches anything on
                its own. A reading arrives only once you hand OpenLimiter that document yourself,
                by pasting it or by running <Code>openlimiter ingest --provider &lt;id&gt;</Code>.
                See <DocLink href="/docs/ingestion">ingestion</DocLink> for the exact paths.
              </Callout>
            </>
          ),
        },
        {
          id: "vocabulary",
          title: "The full connection vocabulary",
          body: (
            <>
              <P>
                Underneath the three chips sits a larger vocabulary: thirteen named states, one
                module in the core package the whole product is built from, each with one plain
                sentence rather than a log line. It exists so a connection&apos;s state is a value
                every surface reads the same way, never a sentence each one is free to invent for
                itself.
              </P>
              <Table
                caption="Every state in the connection vocabulary, and what each one means"
                columns={[
                  { key: "state", header: "state" },
                  { key: "meaning", header: "meaning" },
                ]}
                rows={CONNECTION_STATE_ROWS.map((row) => ({
                  state: <Code>{row.state}</Code>,
                  meaning: row.sentence,
                }))}
              />
              <Bullets
                items={[
                  <>
                    <Code>IMPORT_ONLY</Code>, <Code>MANUAL</Code> and <Code>UNSUPPORTED</Code> are
                    declared rather than attempted, by design: the product states them outright,
                    and nothing that happens afterward, a response, a failure, a timeout, is
                    allowed to quietly promote one of them to <Code>CONNECTED</Code>. Only
                    OpenLimiter itself declaring otherwise moves a connection out of one.
                  </>,
                  <>
                    The rest name a lifecycle a live reader would move a connection through: found
                    but not yet collecting, waiting on a credential, connecting, connected, and,
                    when something goes wrong, degraded, stale, expired, or needing a look.
                  </>,
                ]}
              />
              <Sub id="what-this-is-not-claiming">What this page is not claiming</Sub>
              <P>
                Not that all thirteen are on screen. What the dashboard actually renders today is
                the simpler, three chip vocabulary above, built for a release where nothing
                performs a network read. The thirteen states are real and tested in the core
                package this product is built from, and they name the general lifecycle any
                connection follows once a live reader exists. No surface renders those words yet,
                because nothing today does the thing that would put a connection into one of them:
                no reader, no request, nothing to fail, expire, or need a credential for.
              </P>
            </>
          ),
        },
        {
          id: "what-changes",
          title: "What changes when a live connection ships",
          body: (
            <>
              <P>
                Nothing on this page is a date or a promise. When a provider gains a real reader,
                the honest description of it stops being a fixed chip and starts being whichever
                of the thirteen states above actually fits at that moment: detected, waiting on a
                credential, connecting, connected, or, when something goes wrong, degraded, stale,
                or needing a look. That is the reason to name the whole vocabulary now, before any
                of it is reachable, so the sentence a person reads does not change on the day the
                state underneath it starts moving.
              </P>
              <P>
                No provider has that reader today. See the{" "}
                <DocLink href="/docs/roadmap">roadmap</DocLink> for what is planned and what is
                not, and <DocLink href="/docs/providers">supported providers</DocLink> for what
                each connector can actually do right now.
              </P>
            </>
          ),
        },
      ]}
    />
  );
}
