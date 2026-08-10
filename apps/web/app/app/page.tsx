import { Dashboard } from "./dashboard";
import { BrandLockup, BrandMark } from "@/components/brand";
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
      <BrandMark className="ol-splash-mark h-16 w-16" />
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
              {/*
                Two headers, one markup, swapped by display mode in theme.css.

                In a browser tab the site's own header is directly above this
                one and already carries the lockup, so repeating it is two of
                the same logo a hundred pixels apart. Here the mark stands
                alone at twenty pixels, in the four segment telling that holds
                at that size, and the page's name is the heading.

                Installed, there is no site header at all, so the full lockup
                comes back: it is the only brand on the screen, and the window
                should say what it is. The desktop application counts as the
                installed case and carries the same lockup.
              */}
              <BrandMark
                className="ol-appmark-small h-5 w-5 flex-none text-brand"
                variant="small"
              />
              <span className="ol-appmark-full items-center gap-2.5">
                <BrandLockup
                  markClassName="h-8 w-8 flex-none text-brand sm:h-9 sm:w-9"
                  wordClassName="text-xl sm:text-2xl"
                />
              </span>
              <span aria-hidden="true" className="h-6 w-px flex-none bg-hairline" />
              <h1 className="ol-brand-font truncate text-base text-heading">
                Quota dashboard
              </h1>
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
