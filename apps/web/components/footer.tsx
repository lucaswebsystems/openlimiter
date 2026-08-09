import { links } from "@/components/links";
import { ExternalLink } from "@/components/ui";

const productLinks = [
  { label: "GitHub", href: links.github },
  { label: "Releases", href: links.releases },
  { label: "Roadmap", href: links.issues },
] as const;

const docLinks = [
  { label: "Architecture", href: links.architecture },
  { label: "Security", href: links.security },
  { label: "Threat model", href: links.threatModel },
] as const;

export function Footer() {
  return (
    <footer className="site-footer" aria-label="Site footer">
      <div className="wide-container footer-grid">
        <div className="footer-brand">
          <a className="wordmark" href="#top">
            <span className="wordmark-mark" aria-hidden="true">O</span>
            <span>OpenLimiter</span>
          </a>
          <p>Quota awareness for AI coding agents, inside their own context.</p>
          <a href="https://openlimiter.com">openlimiter.com</a>
        </div>

        <div>
          <h2>Product</h2>
          <ul>
            {productLinks.map((item) => (
              <li key={item.label}>
                <ExternalLink href={item.href}>{item.label}</ExternalLink>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2>Docs</h2>
          <ul>
            {docLinks.map((item) => (
              <li key={item.label}>
                <ExternalLink href={item.href}>{item.label}</ExternalLink>
              </li>
            ))}
          </ul>
        </div>

        <div>
          <h2>Author</h2>
          <ul>
            <li>
              <ExternalLink href={links.author}>Built by Lucas Costa</ExternalLink>
            </li>
            <li>
              <ExternalLink href={links.linkedin}>LinkedIn</ExternalLink>
            </li>
            <li>
              <ExternalLink href={links.authorGithub}>GitHub profile</ExternalLink>
            </li>
          </ul>
        </div>
      </div>

      <div className="wide-container footer-bottom">
        <p>© 2026 OpenLimiter.</p>
        <p>Apache 2.0. Local first. Zero telemetry.</p>
      </div>
    </footer>
  );
}
