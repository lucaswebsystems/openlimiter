import { Dashboard } from "./dashboard";

/**
 * The application at /app.
 *
 * It is the real product surface, not a preview of one. The engine underneath
 * it is the same core, the same connectors and the same adapter the command
 * line tool ships, mirrored into this bundle by app/app/engine/sync.mjs, so a
 * reading here and a reading in a terminal cannot disagree.
 *
 * The page itself is deliberately thin: a title, the four promises the route
 * keeps, and the dashboard. Everything else, including where a document comes
 * from, lives inside the dashboard's own views, so the product is one object
 * on the screen rather than a page with an application somewhere in it.
 */

const PROMISES = ["No upload", "No account", "No analytics", "No request leaves this tab"];

export default function AppPage() {
  return (
    <main id="main" className="px-4 py-10 sm:px-6 sm:py-14 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <header className="flex flex-col gap-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <p className="mb-3 font-mono text-2xs uppercase tracking-widest text-muted">
              Application
            </p>
            <h1 className="font-sans text-2xl font-medium tracking-tight text-heading sm:text-3xl">
              Your quota, read on your own device.
            </h1>
            <p className="mt-3 font-sans text-sm leading-relaxed text-body">
              Hand this page a quota document and it applies exactly the rules
              the command line tool applies: the same validation, the same
              freshness model, the same advice. Install it to a home screen and
              it opens like an application, offline included.
            </p>
          </div>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-2xs uppercase tracking-widest text-muted lg:max-w-56 lg:flex-col lg:gap-y-1.5">
            {PROMISES.map((promise) => (
              <li key={promise}>{promise}</li>
            ))}
          </ul>
        </header>

        <div className="mt-8">
          <Dashboard />
        </div>
      </div>
    </main>
  );
}
