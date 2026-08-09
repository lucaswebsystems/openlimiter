import { Check, GithubLogo, Sparkle } from "@phosphor-icons/react/dist/ssr";
import { links } from "@/components/links";
import { ScrollReveal } from "@/components/scroll-reveal";
import { ExternalLink, SectionIntro } from "@/components/ui";

const freeFeatures = [
  "All connectors",
  "Statusline",
  "Bounded agent context",
  "Doctor checks",
  "Unlimited local use",
] as const;

const proFeatures = [
  "Encrypted sync",
  "Mobile access",
  "Push and email alerts",
  "Longer retention",
  "Team views later",
] as const;

function FeatureList({ items }: { items: readonly string[] }) {
  return (
    <ul className="feature-list">
      {items.map((item) => (
        <li key={item}>
          <Check size={17} weight="regular" aria-hidden="true" />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function Pricing() {
  return (
    <section id="pricing" className="section" aria-labelledby="pricing-title">
      <ScrollReveal className="content-container">
        <div data-reveal-item>
          <SectionIntro
            eyebrow="Simple pricing"
            title="Local power stays free"
            align="center"
          >
            <p>Use every local feature forever. Cloud convenience will remain optional.</p>
          </SectionIntro>
        </div>

        <div className="pricing-grid">
          <article className="price-card" data-reveal-item>
            <div className="price-card-heading">
              <div>
                <p className="price-name">Free</p>
                <p className="price-value">$0</p>
              </div>
              <span className="honesty-badge badge-native">forever</span>
            </div>
            <p className="price-description">Everything local, with no account required.</p>
            <FeatureList items={freeFeatures} />
            <ExternalLink href={links.github} className="button button-ghost button-full">
              <GithubLogo size={19} weight="regular" aria-hidden="true" />
              View on GitHub
            </ExternalLink>
          </article>

          <article className="price-card price-card-pro" data-reveal-item>
            <div className="price-card-heading">
              <div>
                <p className="price-name">Pro</p>
                <p className="price-value">
                  $4.99 <span>monthly</span>
                </p>
              </div>
              <span className="coming-badge">COMING SOON</span>
            </div>
            <p className="price-description">Cloud convenience for people who want it.</p>
            <FeatureList items={proFeatures} />
            <ExternalLink href={links.issues} className="button waitlist-button button-full">
              <Sparkle size={19} weight="regular" aria-hidden="true" />
              Join the waitlist
            </ExternalLink>
          </article>
        </div>

        <p className="sponsor-line" data-reveal-item>
          Want to support the open source work?
          <ExternalLink href={links.sponsors}>
            <GithubLogo size={17} weight="regular" aria-hidden="true" />
            Support the build
          </ExternalLink>
        </p>
      </ScrollReveal>
    </section>
  );
}
