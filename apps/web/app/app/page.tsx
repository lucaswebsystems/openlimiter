import { Dashboard } from "./dashboard";
import { BrandLockup } from "@/components/brand";
import { SHELL } from "@/components/ui";
import { wordmarkFont } from "@/lib/fonts";

/**
 * The application at /app.
 *
 * It is the real product surface, not a preview of one. The engine underneath
 * it is the same core, the same connectors and the same adapter the command
 * line tool ships, mirrored into this bundle by app/app/engine/sync.mjs, so a
 * reading here and a reading in a terminal cannot disagree.
 *
 * The page itself is deliberately thin. Everything the product does lives
 * inside the dashboard's own views, including where a document comes from, so
 * what is on the screen is one object rather than a page with an application
 * somewhere in it.
 *
 * Two things are rendered here rather than in the dashboard, and both for the
 * same reason: they are static, so they belong on the server. The lockup is
 * handed down as a prop, which keeps the wordmark's font out of the client
 * bundle entirely. The splash is plain markup with a CSS animation, so it can
 * paint before a single line of JavaScript has run, which is the only moment
 * it is needed.
 */

const PROMISES = ["No upload", "No account", "No analytics", "No request leaves this tab"];

/**
 * The launch splash.
 *
 * Invisible in a browser tab: theme.css only gives this element a box inside a
 * display mode of standalone. Launched from a home screen it covers the
 * canvas, in the canvas colour, for as long as it takes the dashboard to
 * mount, and it removes itself three separate ways so it can never be the
 * thing a reader is left looking at. See the note above `.ol-splash`.
 */
function Splash() {
  return (
    <div className="ol-splash" aria-hidden="true">
      <BrandLockup
        markClassName="ol-splash-mark h-12 w-12 flex-none text-brand"
        wordClassName="text-3xl"
      />
    </div>
  );
}

export default function AppPage() {
  return (
    <>
      <Splash />
      {/* The brand face reaches this route's stylesheet through the custom
          property the font module publishes, so `.ol-brand-font` in theme.css
          can set a heading without a component to hang a class on. It is the
          same self hosted file the wordmark already uses. */}
      <main
        id="main"
        className={`${wordmarkFont.variable} ol-shell ${SHELL} pb-10 pt-2 md:pb-16`}
      >
        <Dashboard
          lockup={
            <div className="flex min-w-0 items-center gap-3">
              {/* One header for every context. The brand rule is the full
                  lockup on every product surface: mark alone is reserved for
                  the favicon and the desktop icon. In a browser tab the site
                  header above also carries the lockup; the divider and the
                  page name keep this one reading as application chrome rather
                  than a repeat. */}
              <BrandLockup
                markClassName="h-7 w-7 flex-none text-brand sm:h-8 sm:w-8"
                wordClassName="text-lg sm:text-xl"
              />
            </div>
          }
        />

        <div className="mt-8 border-t border-hairline pt-6">
          <ul className="flex flex-wrap gap-2">
            {PROMISES.map((promise) => (
              <li
                key={promise}
                className="inline-flex items-center rounded-full border border-hairline bg-surface px-2.5 py-1 text-xs text-muted"
              >
                {promise}
              </li>
            ))}
          </ul>
          <p className="mt-4 max-w-2xl text-sm leading-relaxed text-muted">
            Hand this page a quota document and it applies exactly the rules the
            command line tool applies: the same validation, the same freshness
            model, the same advice. Install it to a home screen and it opens
            like an application, offline included.
          </p>
        </div>
      </main>
    </>
  );
}
