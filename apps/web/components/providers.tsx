import {
  Brain,
  Browser,
  Cloud,
  Code,
  Compass,
  DotsThreeOutline,
  Hand,
} from "@phosphor-icons/react/dist/ssr";
import { ScrollReveal } from "@/components/scroll-reveal";
import { IconChip, SectionIntro } from "@/components/ui";

const providers = [
  {
    name: "Claude",
    icon: Brain,
    badge: "native payload",
    tone: "badge-native",
    body: "Parses a native quota payload you provide into bounded local state.",
  },
  {
    name: "Codex",
    icon: Code,
    badge: "internal endpoint, may break",
    tone: "badge-warning",
    body: "Parses data shaped like an unofficial interface and fails safe when its shape changes.",
  },
  {
    name: "Antigravity",
    icon: Compass,
    badge: "internal endpoint, may break",
    tone: "badge-warning",
    body: "Parses Gemini Antigravity data shaped like an interface that may change.",
  },
  {
    name: "OpenCode",
    icon: Browser,
    badge: "session based, may break",
    tone: "badge-warning",
    body: "Parses session shaped quota data you provide without mutating provider files.",
  },
  {
    name: "OpenRouter",
    icon: Cloud,
    badge: "documented API",
    tone: "badge-native",
    body: "Normalizes a documented API payload you provide into the shared snapshot schema.",
  },
  {
    name: "Manual",
    icon: Hand,
    badge: "user entered",
    tone: "badge-manual",
    body: "Normalizes user entered values supplied to the connector.",
  },
] as const;

export function Providers() {
  return (
    <section id="providers" className="section section-tinted" aria-labelledby="providers-title">
      <ScrollReveal className="wide-container">
        <div data-reveal-item>
          <SectionIntro
            eyebrow="Honest connectors"
            title="One view across the tools you use"
          >
            <p>
              Every connector says how it gets its data. Unofficial paths are
              labeled clearly because provider interfaces can change.
            </p>
          </SectionIntro>
        </div>

        <div className="provider-grid">
          {providers.map((provider) => (
            <article key={provider.name} className="provider-card" data-reveal-item>
              <IconChip icon={provider.icon} />
              <h3>{provider.name}</h3>
              <span className={`honesty-badge ${provider.tone}`}>{provider.badge}</span>
              <p>{provider.body}</p>
            </article>
          ))}

          <article className="provider-card provider-card-ghost" data-reveal-item>
            <IconChip icon={DotsThreeOutline} />
            <h3>More coming</h3>
            <span className="honesty-badge badge-manual">planned</span>
            <p>Cursor, Copilot, Devin, Grok, and Z.ai are on the horizon.</p>
          </article>
        </div>
      </ScrollReveal>
    </section>
  );
}
