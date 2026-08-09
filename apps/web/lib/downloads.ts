import { RELEASES_LATEST_URL, type ShipState } from "./site";

/**
 * Every way there is to get OpenLimiter, and the honest state of each one.
 *
 * The hero button row, the download page and the footer all read this list, so
 * a platform cannot be advertised in one place and missing in another. Only the
 * rows marked `available` describe something a reader can run today. The rest
 * say so in the chip, in the prose, and in the accessible name of any control
 * that points at them.
 *
 * Two things on this list are packaged artifacts rather than a build: the
 * Windows installer, which is produced by the desktop workspace and attached to
 * a GitHub release, and the web app, which is simply a route on this site. Every
 * other row is a clone and a build, and says so. The package is not on npm, so
 * there is deliberately no global install line anywhere on this site. When the
 * package is published, the npm row changes state and gains a command, and every
 * surface follows it.
 */

export interface DownloadTarget {
  /** Anchor id on /download, and the fragment every button links to. */
  id: string;
  name: string;
  state: ShipState;
  /** One sentence, plain, no promise of a date. */
  summary: string;
  /** The exact command, when one exists. */
  command?: string;
  /** What the reader needs before the command works. */
  requirement?: string;
  /** Where the artifact actually is, for the rows that have one. */
  href?: string;
  /** The words on the control that points at href. */
  hrefLabel?: string;
  /** Whether that control leaves this site. */
  hrefExternal?: boolean;
}

const BUILD_FROM_SOURCE = `git clone https://github.com/lucaswebsystems/openlimiter
cd openlimiter
pnpm install
pnpm build
pnpm openlimiter demo`;

const TOOLCHAIN = "Node 24 or newer and pnpm 9.15.0, which the repository pins.";

export const downloadTargets: readonly DownloadTarget[] = [
  {
    id: "source",
    name: "From source",
    state: "available",
    summary:
      "The command line tool, on any platform, and the path every capture on this site was taken from. Clone the repository, build the workspace, and the tool is ready.",
    command: BUILD_FROM_SOURCE,
    requirement: TOOLCHAIN,
  },
  {
    id: "windows",
    name: "Windows",
    state: "available",
    summary:
      "The desktop application is packaged for Windows as an installer and attached to the release on GitHub. The command line tool builds from the same clone as everywhere else, and all one hundred tests run on Windows in continuous integration on every commit.",
    command: BUILD_FROM_SOURCE,
    requirement: `${TOOLCHAIN} PowerShell or any terminal you like.`,
    href: RELEASES_LATEST_URL,
    hrefLabel: "Get the Windows installer",
    hrefExternal: true,
  },
  {
    id: "macos",
    name: "macOS",
    state: "available",
    summary:
      "Same clone, same build, for the command line tool. Apple silicon and Intel both run it, because it is plain Node.js with no third party runtime dependencies. There is no packaged desktop build for macOS yet.",
    command: BUILD_FROM_SOURCE,
    requirement: TOOLCHAIN,
  },
  {
    id: "linux",
    name: "Linux",
    state: "available",
    summary:
      "Same clone, same build, for the command line tool, tested on Linux alongside Windows on every push. There is no packaged desktop build for Linux yet.",
    command: BUILD_FROM_SOURCE,
    requirement: TOOLCHAIN,
  },
  {
    id: "web-app",
    name: "Web app",
    state: "available",
    summary:
      "Nothing to install. The web app runs the same engine as the command line tool inside the browser tab, on a document you paste or drop, and it installs to a phone or desktop home screen and keeps working offline. Nothing is uploaded and there is no account.",
    href: "/app",
    hrefLabel: "Open the web app",
  },
  {
    id: "desktop",
    name: "Desktop application",
    state: "in development",
    summary:
      "A tray icon beside the system clock, reading the same local cache the command line tool writes. It is built and it runs, and the Windows installer above is the first packaged release of it. There is no macOS or Linux package yet, and no automatic update channel.",
  },
  {
    id: "npm",
    name: "Global install from npm",
    state: "planned",
    summary:
      "OpenLimiter is not published to npm, so there is no global command to install and no package to add to a project. Until it is published, use the clone above and run the tool through pnpm from the repository root.",
  },
  {
    id: "ios",
    name: "iOS",
    state: "planned",
    summary:
      "Planned. Nothing has been submitted to the App Store, there is no build, and there is no waiting list. The web app installs to an iPhone home screen today, which is the nearest thing that exists.",
  },
  {
    id: "android",
    name: "Android",
    state: "planned",
    summary:
      "Planned. Nothing has been submitted to Google Play, there is no build, and there is no waiting list. The web app installs to an Android home screen today, which is the nearest thing that exists.",
  },
];

/** The one line that sits under the hero buttons, so nothing there overpromises. */
export const DOWNLOAD_DISCLAIMER =
  "Windows has a packaged installer on the releases page. The web app opens in any browser. macOS and Linux build the command line tool from a clone, there is no npm package yet, and the mobile applications are not built.";

/** The four rows a reader thinks of as a platform, in the order they read. */
const PLATFORM_IDS = ["source", "windows", "macos", "linux"] as const;

/** What the footer lists under Download. Platforms only, in that order. */
export const platformTargets: readonly DownloadTarget[] = PLATFORM_IDS.map(
  (id) => downloadTargets.find((target) => target.id === id),
).filter((target): target is DownloadTarget => target !== undefined);

export function findTarget(id: string): DownloadTarget | undefined {
  return downloadTargets.find((target) => target.state === "available" && target.id === id) ??
    downloadTargets.find((target) => target.id === id);
}
