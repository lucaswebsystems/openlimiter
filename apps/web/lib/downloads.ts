import { CURRENT_VERSION, REPO_URL, type ShipState } from "./site";

/**
 * Every way there is to get OpenLimiter, and the honest state of each one.
 *
 * The hero button row, the download page and the footer all read this list, so
 * a platform cannot be advertised in one place and missing in another. Only the
 * rows marked `available` describe something a reader can run today. The rest
 * say so in the chip, in the prose, and in the accessible name of any control
 * that points at them.
 *
 * Windows, macOS and Linux each have packaged desktop builds attached to the
 * release, and every link below is the artifact itself rather than a page that
 * lists artifacts, so a reader lands on the file instead of on a hunt. None of
 * those builds are code signed yet, which the row states plainly and tells the
 * reader how to get past, rather than leaving the operating system to spring it
 * on them. The two rows that are not a file are the web app, which is a route
 * on this site, and the global install, which is a published npm package.
 */

/**
 * The artifact names follow the bundler's own convention, so they track
 * CURRENT_VERSION. Bump that constant only when the matching release is tagged
 * and its assets are uploaded, or every link on this page points at nothing.
 */
const WINDOWS_SETUP = `OpenLimiter_${CURRENT_VERSION}_x64-setup.exe`;
const WINDOWS_MSI = `OpenLimiter_${CURRENT_VERSION}_x64_en-US.msi`;
const MACOS_APPLE_SILICON = `OpenLimiter_${CURRENT_VERSION}_aarch64.dmg`;
const MACOS_INTEL = `OpenLimiter_${CURRENT_VERSION}_x64.dmg`;
const LINUX_APPIMAGE = `OpenLimiter_${CURRENT_VERSION}_amd64.AppImage`;
const LINUX_DEB = `OpenLimiter_${CURRENT_VERSION}_amd64.deb`;
const LINUX_RPM = `OpenLimiter-${CURRENT_VERSION}-1.x86_64.rpm`;

/** The direct link to one packaged file on the tagged release. */
function releaseAsset(file: string): string {
  return `${REPO_URL}/releases/download/v${CURRENT_VERSION}/${file}`;
}

/** One packaged file a reader can download for a platform. */
export interface DownloadAsset {
  /** The words on the control. */
  label: string;
  /** The artifact itself, never a page that lists artifacts. */
  href: string;
  /** The one most readers on that platform want. Rendered first and solid. */
  primary?: boolean;
}

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
  /** Every packaged file for this platform, for the rows that have them. */
  assets?: readonly DownloadAsset[];
  /** The caveat that sits under the controls, and what to do about it. */
  note?: string;
  /** Where the artifact actually is, for the rows that have exactly one. */
  href?: string;
  /** The words on the control that points at href. */
  hrefLabel?: string;
  /** Whether that control leaves this site. */
  hrefExternal?: boolean;
}

/** The Windows build the hero's primary button points at. */
export const WINDOWS_SETUP_URL = releaseAsset(WINDOWS_SETUP);

/** The macOS build the hero's Apple button points at. */
export const MACOS_APPLE_SILICON_URL = releaseAsset(MACOS_APPLE_SILICON);

const BUILD_FROM_SOURCE = `git clone https://github.com/lucaswebsystems/openlimiter
cd openlimiter
pnpm install
pnpm build
node packages/cli/dist/bin.js demo`;

const TOOLCHAIN = "Node 24 or newer and pnpm 9.15.0, which the repository pins.";

export const downloadTargets: readonly DownloadTarget[] = [
  {
    id: "npm",
    name: "Global install from npm",
    state: "available",
    summary:
      "Recommended for the command line tool. Install the published package globally, then run openlimiter from any directory.",
    command: "npm install -g openlimiter",
    requirement: "Node 24 or newer and npm.",
    href: "https://www.npmjs.com/package/openlimiter",
    hrefLabel: "View the npm package",
    hrefExternal: true,
  },
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
      "The desktop application is packaged for Windows two ways, and both are attached to the release: an installer for a normal machine, and an MSI for anyone putting it on several. The command line tool installs from npm on Windows like anywhere else, and all one hundred tests run on Windows in continuous integration on every commit.",
    assets: [
      { label: "Windows installer", href: releaseAsset(WINDOWS_SETUP), primary: true },
      { label: "Windows MSI", href: releaseAsset(WINDOWS_MSI) },
    ],
    note:
      "Neither Windows build is code signed yet, so SmartScreen warns the first time you run it. Choose More info, then Run anyway.",
    command: BUILD_FROM_SOURCE,
    requirement: `${TOOLCHAIN} PowerShell or any terminal you like.`,
  },
  {
    id: "macos",
    name: "macOS",
    state: "available",
    summary:
      "The desktop application is packaged for macOS as a disk image for each chip family, Apple silicon and Intel, and both are attached to the release. The command line tool runs on either from npm, because it is plain Node.js with no third party runtime dependencies.",
    assets: [
      { label: "Apple silicon DMG", href: releaseAsset(MACOS_APPLE_SILICON), primary: true },
      { label: "Intel DMG", href: releaseAsset(MACOS_INTEL) },
    ],
    note:
      "The disk images are not notarised yet, so Gatekeeper refuses to open the application on a double click. Right click it and choose Open the first time, then confirm.",
    command: BUILD_FROM_SOURCE,
    requirement: TOOLCHAIN,
  },
  {
    id: "linux",
    name: "Linux",
    state: "available",
    summary:
      "The desktop application is packaged for Linux three ways, all attached to the release: an AppImage that runs on anything, a deb for Debian and Ubuntu, and an rpm for Fedora and openSUSE. The command line tool installs from npm and is tested on Linux alongside Windows on every push.",
    assets: [
      { label: "AppImage", href: releaseAsset(LINUX_APPIMAGE), primary: true },
      { label: "deb for Debian and Ubuntu", href: releaseAsset(LINUX_DEB) },
      { label: "rpm for Fedora and openSUSE", href: releaseAsset(LINUX_RPM) },
    ],
    note:
      "The AppImage needs its executable bit set before it will run. Tick that box in your file manager, or run chmod +x on the file you downloaded.",
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
    state: "available",
    summary:
      "A tray icon beside the system clock, reading the same local cache the command line tool writes, so quota is glanceable with no terminal open. It is packaged for Windows, macOS and Linux, and every build is attached to the same release. There is no automatic update channel yet, so a new version means downloading it again.",
    note:
      "None of the desktop builds are code signed yet. Windows SmartScreen and macOS Gatekeeper both warn on first run, and each platform row above says how to get past it.",
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
  "Windows, macOS and Linux all have packaged desktop builds on the release, and npm is the recommended command line install. The web app needs nothing installed. The desktop builds are not code signed yet, so Windows and macOS warn on first run. The mobile applications are not built.";

/** The five rows a reader thinks of as a platform, in the order they read. */
const PLATFORM_IDS = ["npm", "source", "windows", "macos", "linux"] as const;

/** What the footer lists under Download. Platforms only, in that order. */
export const platformTargets: readonly DownloadTarget[] = PLATFORM_IDS.map(
  (id) => downloadTargets.find((target) => target.id === id),
).filter((target): target is DownloadTarget => target !== undefined);

export function findTarget(id: string): DownloadTarget | undefined {
  return downloadTargets.find((target) => target.state === "available" && target.id === id) ??
    downloadTargets.find((target) => target.id === id);
}
