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
 *
 * STRUCTURE HERE, WORDS IN THE CATALOG
 * ------------------------------------
 * Every row used to carry its own prose as literals. The site is published in
 * five languages now, so what stays below is the part that is the same in all
 * five: the id, the ship state, the command, the artifact urls, and the order
 * the rows read in. Each row's words live at `download.targets.<id>` in the
 * catalogs, keyed by the id that is already the anchor on /download, so the
 * catalog reads beside the page it draws:
 *
 *   `name`          the row's heading
 *   `summary`       one sentence, plain, no promise of a date
 *   `requirement`   what the reader needs before the command works
 *   `note`          the caveat under the controls, and what to do about it
 *   `hrefLabel`     the words on the control that points at `href`
 *   `assets.<id>`   the words on one packaged file's control
 *
 * A row without a note or a requirement simply has no such key, and the page
 * asks the catalog whether one exists rather than reading a flag from here.
 *
 * The three ship states keep their own entries, `download.states.*`, because
 * they are one shared vocabulary rather than a label per row.
 *
 * The toolchain sentence used to be one constant three rows shared. It is
 * written out in each of those rows' catalog entries now, because a message is
 * translated whole and is never assembled from pieces at a call site.
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
  /** Catalog key. `download.targets.<target>.assets.<id>` is its control. */
  id: string;
  /** The artifact itself, never a page that lists artifacts. */
  href: string;
  /** The one most readers on that platform want. Rendered first and solid. */
  primary?: boolean;
}

export interface DownloadTarget {
  /**
   * Anchor id on /download, and the fragment every button links to. It is the
   * catalog key as well: `download.targets.<id>` holds this row's words.
   */
  id: string;
  state: ShipState;
  /** The exact command, when one exists. */
  command?: string;
  /** Every packaged file for this platform, for the rows that have them. */
  assets?: readonly DownloadAsset[];
  /** Where the artifact actually is, for the rows that have exactly one. */
  href?: string;
  /** Whether the control that points at `href` leaves this site. */
  hrefExternal?: boolean;
}

const BUILD_FROM_SOURCE = `git clone https://github.com/lucaswebsystems/openlimiter
cd openlimiter
pnpm install
pnpm build
node packages/cli/dist/bin.js demo`;

export const downloadTargets: readonly DownloadTarget[] = [
  {
    id: "npm",
    state: "available",
    command: "npm install -g openlimiter",
    href: "https://www.npmjs.com/package/openlimiter",
    hrefExternal: true,
  },
  {
    id: "source",
    state: "available",
    command: BUILD_FROM_SOURCE,
  },
  {
    id: "windows",
    state: "available",
    assets: [
      { id: "setup", href: releaseAsset(WINDOWS_SETUP), primary: true },
      { id: "msi", href: releaseAsset(WINDOWS_MSI) },
    ],
    command: BUILD_FROM_SOURCE,
  },
  {
    id: "macos",
    state: "available",
    assets: [
      { id: "appleSilicon", href: releaseAsset(MACOS_APPLE_SILICON), primary: true },
      { id: "intel", href: releaseAsset(MACOS_INTEL) },
    ],
    command: BUILD_FROM_SOURCE,
  },
  {
    id: "linux",
    state: "available",
    assets: [
      { id: "appImage", href: releaseAsset(LINUX_APPIMAGE), primary: true },
      { id: "deb", href: releaseAsset(LINUX_DEB) },
      { id: "rpm", href: releaseAsset(LINUX_RPM) },
    ],
    command: BUILD_FROM_SOURCE,
  },
  {
    id: "web-app",
    state: "available",
    href: "/app",
  },
  {
    id: "desktop",
    state: "available",
  },
  {
    /* `iphone` rather than `ios`: this id is the anchor on /download, and the
       fold's iPhone button points at /download#iphone by the founder's order.
       The row below is where the real install flow lives. */
    id: "iphone",
    state: "planned",
  },
  {
    id: "android",
    state: "planned",
  },
];


