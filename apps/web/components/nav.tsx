import { GithubLogo } from "@phosphor-icons/react/dist/ssr";
import { links } from "@/components/links";
import { ExternalLink } from "@/components/ui";

const navItems = [
  { href: "#how-it-works", label: "How it works" },
  { href: "#providers", label: "Providers" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
] as const;

export function Nav() {
  return (
    <header className="site-header">
      <nav className="nav-pill" aria-label="Primary navigation">
        <a className="wordmark" href="#top" aria-label="OpenLimiter home">
          <span className="wordmark-mark" aria-hidden="true">O</span>
          <span>OpenLimiter</span>
        </a>

        <div className="nav-links">
          {navItems.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </div>

        <ExternalLink href={links.github} className="nav-github">
          <GithubLogo size={18} weight="regular" aria-hidden="true" />
          <span className="nav-github-label">GitHub</span>
          <span className="sr-only">Open GitHub repository</span>
        </ExternalLink>
      </nav>
    </header>
  );
}
