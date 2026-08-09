import type { ShipState } from "./site";

/**
 * Every way there is to get OpenLimiter, and the honest state of each one.
 *
 * The hero button row, the download page and the footer all read this list, so
 * a platform cannot be advertised in one place and missing in another. Only the
 * rows marked `available` describe something a reader can run today. The rest
 * say so in the chip, in the prose, and in the accessible name of any control
 * that points at them.
 *
 * Every command below is the sequence the repository's own README gives, and
 * the package is not on npm, so there is deliberately no global install line
 * anywhere on this site. When the package is published, the npm row changes
 * state and gains a command, and every surface follows it.
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
      "This is the only way to run OpenLimiter today, and it is the path every capture on this site was taken from. Clone the repository, build the workspace, and the command line tool is ready.",
    command: BUILD_FROM_SOURCE,
    requirement: TOOLCHAIN,
  },
  {
    id: "windows",
    name: "Windows",
    state: "available",
    summary:
      "Same clone, same build. All one hundred tests run on Windows in continuous integration on every commit, and the cache writer retries the transient file locks Windows reports.",
    command: BUILD_FROM_SOURCE,
    requirement: `${TOOLCHAIN} PowerShell or any terminal you like.`,
  },
  {
    id: "macos",
    name: "macOS",
    state: "available",
    summary:
      "Same clone, same build. Apple silicon and Intel both run it, because it is plain Node.js with no third party runtime dependencies.",
    command: BUILD_FROM_SOURCE,
    requirement: TOOLCHAIN,
  },
  {
    id: "linux",
    name: "Linux",
    state: "available",
    summary:
      "Same clone, same build, and tested on Linux alongside Windows on every push.",
    command: BUILD_FROM_SOURCE,
    requirement: TOOLCHAIN,
  },
  {
    id: "npm",
    name: "Global install from npm",
    state: "planned",
    summary:
      "OpenLimiter is not published to npm, so there is no global command to install and no package to add to a project. Until it is published, use the clone above and run the tool through pnpm from the repository root.",
  },
  {
    id: "desktop",
    name: "Desktop application",
    state: "in development",
    summary:
      "A tray icon beside the system clock, reading the same local cache the command line tool already writes. It is being built now. There is no build to download yet and no date.",
  },
  {
    id: "web-app",
    name: "Web app",
    state: "planned",
    summary:
      "A browser view of the same local snapshot, installable to a phone home screen. Planned. There is nothing to open yet.",
  },
  {
    id: "ios",
    name: "iOS",
    state: "planned",
    summary:
      "Planned. Nothing has been submitted to the App Store, there is no build, and there is no waiting list.",
  },
  {
    id: "android",
    name: "Android",
    state: "planned",
    summary:
      "Planned. Nothing has been submitted to Google Play, there is no build, and there is no waiting list.",
  },
];

/** The one line that sits under the hero buttons, so nothing there overpromises. */
export const DOWNLOAD_DISCLAIMER =
  "Windows, macOS and Linux build and run it from a clone today. There is no npm package yet, and desktop, web and mobile are not built.";

export function findTarget(id: string): DownloadTarget | undefined {
  return downloadTargets.find((target) => target.state === "available" && target.id === id) ??
    downloadTargets.find((target) => target.id === id);
}
