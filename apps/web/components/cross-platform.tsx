import {
  AppleLogo,
  LinuxLogo,
  WindowsLogo,
} from "@phosphor-icons/react/dist/ssr";
import { ScrollReveal } from "@/components/scroll-reveal";
import { SectionIntro } from "@/components/ui";

const platforms = [
  {
    icon: WindowsLogo,
    name: "Windows",
    note: "First class",
  },
  {
    icon: AppleLogo,
    name: "macOS",
    note: "Cross platform",
  },
  {
    icon: LinuxLogo,
    name: "Linux",
    note: "Cross platform",
  },
] as const;

export function CrossPlatform() {
  return (
    <section className="section" aria-labelledby="platform-title">
      <ScrollReveal className="narrow-container centered-section">
        <div data-reveal-item>
          <SectionIntro
            eyebrow="Every desk"
            title="Born on Windows, built for every desk."
            align="center"
          >
            <p>
              The category leader is limited to macOS. OpenLimiter starts with
              Windows as a first class platform, with macOS and Linux alongside it.
            </p>
          </SectionIntro>
        </div>

        <div className="platform-grid">
          {platforms.map(({ icon: PlatformIcon, name, note }) => (
            <div key={name} className="platform-item" data-reveal-item>
              <PlatformIcon size={34} weight="regular" aria-hidden="true" />
              <strong>{name}</strong>
              <span>{note}</span>
            </div>
          ))}
        </div>
      </ScrollReveal>
    </section>
  );
}
