import Link from "next/link";
import { PhonePanels } from "./phone-panels";
import { SectionHeading } from "./ui";
import { reveal } from "@/lib/motion";

/**
 * Runs where you work.
 *
 * The three shells hold real captures of the web app at phone size, which is
 * why the note underneath calls them screenshots rather than a mockup. The
 * numbers inside them come from the project's synthetic fixtures, so every
 * shell carries a demo data chip. The iOS and Android applications remain
 * planned and unbuilt, and nothing here suggests otherwise.
 *
 * There is no transcript on this section any more. The statusline and the hook
 * are shown once each, in the two sections that exist to explain them, rather
 * than a third time here.
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
        Those are screenshots of the web app running at phone size, against the project&apos;s
        synthetic fixtures, which is why each one carries a demo data chip. The same reading opens
        in any browser at the{" "}
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
