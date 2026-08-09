import Link from "next/link";
import { PhonePanels } from "./phone-panels";
import { SectionHeading } from "./ui";
import { reveal } from "@/lib/motion";

/**
 * Runs where you work.
 *
 * The three panels are phone sized because that is the shape the web app takes
 * on a phone, and the web app is real: it is at /app, it runs the same engine,
 * and it installs to a home screen. What the panels hold is still the command
 * line tool's own captured output at phone width rather than a screenshot of
 * the browser, which the note underneath says in the open. The iOS and Android
 * applications remain planned and unbuilt, and nothing here suggests otherwise.
 */
export function RunsWhere() {
  return (
    <section id="runs-where">
      <SectionHeading
        title="Runs where you work"
        lead="Windows, macOS and Linux, from a terminal, a statusline, a prompt hook or a script, and in any browser through the web app. One local cache, read by whatever you point at it."
      />
      <div {...reveal}>
        <PhonePanels />
      </div>
      <p className="mx-auto mt-8 max-w-2xl text-center text-sm leading-relaxed text-muted" {...reveal}>
        These three panels are the real snapshot at phone width, not a mockup of an application.
        Every provider, meter and percentage in them is parsed from verbatim captured output of the
        command line tool against synthetic fixtures, which is why each one carries a demo data
        chip. The same reading opens in a browser in the{" "}
        <Link
          href="/app"
          className="focus-ring rounded text-accent transition-colors hover:text-accent-hover"
        >
          web app
        </Link>
        , which installs to a home screen. Native iOS and Android applications are planned and not
        built.
      </p>
    </section>
  );
}
