export function Footer() {
  return (
    <footer className="border-t border-hairline bg-canvas px-4 py-16 sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8">
          {/* Column 1: Product */}
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-heading mb-4">
              Product
            </h3>
            <ul className="space-y-2.5 font-sans text-xs text-body">
              <li>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-heading"
                >
                  GitHub
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/releases"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-heading"
                >
                  Releases
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-heading"
                >
                  Roadmap
                </a>
              </li>
            </ul>
          </div>

          {/* Column 2: Docs */}
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-heading mb-4">
              Docs
            </h3>
            <ul className="space-y-2.5 font-sans text-xs text-body">
              <li>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/blob/main/ARCHITECTURE.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-heading"
                >
                  Architecture
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/blob/main/SECURITY.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-heading"
                >
                  Security
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/blob/main/THREAT_MODEL.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-heading"
                >
                  Threat model
                </a>
              </li>
            </ul>
          </div>

          {/* Column 3: Community */}
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-heading mb-4">
              Community
            </h3>
            <ul className="space-y-2.5 font-sans text-xs text-body">
              <li>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/discussions"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-heading"
                >
                  GitHub Discussions
                </a>
              </li>
              <li>
                <a
                  href="https://github.com/lucaswebsystems/openlimiter/issues"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="transition-colors hover:text-heading"
                >
                  Issues
                </a>
              </li>
            </ul>
          </div>

          {/* Column 4: Author */}
          <div>
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-heading mb-4">
              Author
            </h3>
            <div className="font-sans text-xs text-body space-y-2">
              <p>Built by Lucas Costa</p>
              <div className="flex flex-col space-y-1.5 pt-1">
                <a
                  href="https://lucaswebsystems.com"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent transition-colors hover:text-accent-hover"
                >
                  lucaswebsystems.com
                </a>
                <a
                  href="https://www.linkedin.com/in/lucas-costa-t/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent transition-colors hover:text-accent-hover"
                >
                  LinkedIn
                </a>
                <a
                  href="https://github.com/lucaswebsystems"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent transition-colors hover:text-accent-hover"
                >
                  GitHub @lucaswebsystems
                </a>
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Bar */}
        <div className="mt-12 pt-8 border-t border-hairline flex flex-col sm:flex-row items-center justify-between gap-4 font-mono text-xs text-label">
          <div>Apache 2.0. Local first. Zero telemetry.</div>
          <div>openlimiter.com</div>
        </div>
      </div>
    </footer>
  );
}
