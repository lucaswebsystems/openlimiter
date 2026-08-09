import { Dashboard } from "./dashboard";

/**
 * The application at /app.
 *
 * It is the real product surface, not a preview of one. The engine underneath
 * it is the same core, the same connectors and the same adapter the command
 * line tool ships, mirrored into this bundle by app/app/engine/sync.mjs, so a
 * reading here and a reading in a terminal cannot disagree.
 */
export default function AppPage() {
  return (
    <main id="main" className="px-4 py-12 sm:px-6 sm:py-16 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="max-w-2xl">
          <p className="mb-3 font-mono text-2xs uppercase tracking-widest text-muted">
            Application
          </p>
          <h1 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
            Your quota, read on your own device.
          </h1>
          <p className="mt-3 font-sans text-sm leading-relaxed text-body">
            Hand this page a quota document and it applies exactly the rules the
            command line tool applies: the same validation, the same freshness
            model, the same advice. Install it to a home screen and it opens like
            an application, offline included.
          </p>
        </header>

        <div className="mt-6 flex flex-wrap gap-x-6 gap-y-2 font-mono text-2xs uppercase tracking-widest text-muted">
          <span>No upload</span>
          <span>No account</span>
          <span>No analytics</span>
          <span>No request leaves this tab</span>
        </div>

        <div className="mt-10">
          <Dashboard />
        </div>

        <section className="mt-10 rounded-2xl border border-hairline bg-surface p-5 sm:p-6">
          <h2 className="font-sans text-base font-medium text-heading">
            Where a document comes from
          </h2>
          <div className="mt-4 grid grid-cols-1 gap-5 sm:grid-cols-3">
            <div>
              <h3 className="font-mono text-2xs uppercase tracking-widest text-muted">
                From the tool
              </h3>
              <p className="mt-2 font-sans text-sm leading-relaxed text-body">
                Run <code className="font-mono text-xs text-heading">openlimiter export</code>{" "}
                and paste what it prints. That is the whole cache, already
                validated once.
              </p>
            </div>
            <div>
              <h3 className="font-mono text-2xs uppercase tracking-widest text-muted">
                From your agent
              </h3>
              <p className="mt-2 font-sans text-sm leading-relaxed text-body">
                A Claude Code statusline payload works as it is, including the
                rate limit block it already carries.
              </p>
            </div>
            <div>
              <h3 className="font-mono text-2xs uppercase tracking-widest text-muted">
                From your own notes
              </h3>
              <p className="mt-2 font-sans text-sm leading-relaxed text-body">
                A manual quota document covers a provider with no interface at
                all. You write down what you know, it does the arithmetic.
              </p>
            </div>
          </div>
          <p className="mt-5 font-sans text-sm leading-relaxed text-body">
            On the same network as the machine doing the work? Run{" "}
            <code className="font-mono text-xs text-heading">openlimiter serve</code>{" "}
            there and scan the code it prints. Your phone then reads the live
            quota on that machine directly, with no cloud in the middle.
          </p>
        </section>
      </div>
    </main>
  );
}
