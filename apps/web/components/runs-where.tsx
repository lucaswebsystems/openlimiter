import { PhonePanels } from "./phone-panels";
import { SectionHeading } from "./ui";

/**
 * Runs where you work.
 *
 * The three panels are phone sized because that is what the planned web app
 * will be, but the web app does not exist yet and nothing here implies it does.
 * The panels hold the real snapshot instead, parsed from the captured output of
 * the command line tool, at phone width. The lead says so in the open.
 */
export function RunsWhere() {
  return (
    <section id="runs-where">
      <SectionHeading
        title="Runs where you work"
        lead="Windows, macOS and Linux, from a terminal, a statusline, a prompt hook or a script. One local cache, read by whatever you point at it."
      />
      <PhonePanels />
      <p className="mx-auto mt-8 max-w-xl text-center text-sm leading-relaxed text-muted">
        These three panels are the real snapshot at phone width, not a mockup of an application.
        Every provider, meter and percentage in them is parsed from verbatim captured output of the
        command line tool against synthetic fixtures, which is why each one carries a demo data
        chip. The phone app itself is planned and not built.
      </p>
    </section>
  );
}
