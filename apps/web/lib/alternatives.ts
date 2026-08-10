/**
 * Honest comparison data.
 *
 * Every claim on this page was read off the project's own repository, README or
 * store listing in August 2026, and the source is linked beside it. Where a
 * fact could not be confirmed it says so rather than guessing, and where a name
 * is contested on GitHub the exact repository is named so a reader does not
 * land on a different project.
 *
 * The rule for the `strength` field is that it must be something the tool
 * genuinely does better than OpenLimiter, written plainly. The rule for
 * `difference` is that it describes scope, not quality: these are good tools
 * solving overlapping problems, and several of them are more mature than this
 * one. Nothing here is written to make OpenLimiter look better than it is.
 */

export interface Alternative {
  slug: string;
  name: string;
  /** The exact project, because three of these names are contested. */
  url: string;
  /** One line for the index page and the comparison table. */
  summary: string;
  /** Two plain sentences on what it does. */
  what: string;
  platform: string;
  licence: string;
  /** Which providers or tools it covers, as its own documentation lists them. */
  coverage: string;
  /** Local files, a provider API, or both. */
  source: string;
  /** A real strength, not a concession. */
  strength: string;
  /** A scope difference, written without claiming superiority. */
  difference: string;
  /** Any ambiguity a reader needs before they go looking. */
  caveat?: string;
}

export const alternatives: readonly Alternative[] = [
  {
    slug: "ccusage",
    name: "ccusage",
    url: "https://github.com/ryoppippi/ccusage",
    summary: "The broadest local log reader, and the only genuinely cross platform tool here.",
    what:
      "It reads the JSONL session logs that coding agent command line tools already write to your disk and turns them into daily, weekly, monthly and per session token and cost reports. Its own description is analysing coding agent token usage and costs from local data.",
    platform: "Command line, Node based, run with npx. Windows, macOS and Linux.",
    licence: "MIT",
    coverage:
      "Claude Code, Codex, OpenCode, Amp, Droid, Codebuff, Hermes Agent, pi-agent, Goose, OpenClaw, Kilo, Kimi, Qwen, GitHub Copilot CLI and Gemini CLI, as its site lists them.",
    source: "Local files only. It uploads nothing and calls no provider API.",
    strength:
      "The breadth of its log parsers is unmatched: more than fifteen agent tools from one binary, with no credentials and no setup at all. It also emits structured JSON and ships a Claude Code statusline hook.",
    difference:
      "It reports what you already spent, not what you have left. Its only quota notion is a token limit you supply yourself on the blocks report, so it never reads a real remaining figure from a provider. OpenLimiter starts from the provider's own remaining percentage and hands that to an agent as a bounded block.",
  },
  {
    slug: "openusage",
    name: "OpenUsage",
    url: "https://github.com/robinebers/openusage",
    summary: "The closest overlap, and the only other tool that designs for machine consumers.",
    what:
      "It is a native Swift menu bar application that shows session limits, weekly limits, credits and spend for your AI coding subscriptions in one popover. It also publishes those limits as JSON on a local port so other software can read them.",
    platform: "macOS menu bar only. Requires macOS 15 Sequoia or later.",
    licence: "MIT",
    coverage:
      "Antigravity, Claude, Codex, Copilot, Cursor, Devin, Grok, OpenCode, OpenRouter and Z.ai.",
    source:
      "Both. Most providers are read from credentials already on your machine, some need a key you supply, and consumption is computed from local command line logs or an exported usage file.",
    strength:
      "It is the only tool in this list whose documentation explicitly targets other programs: other applications read machine friendly limits from a local endpoint, and agents read stable limit JSON through the same cache. That is the same instinct OpenLimiter is built on, and OpenUsage got there first.",
    difference:
      "It stops at exposing the numbers and leaves every decision to whatever reads them. OpenLimiter turns the same numbers into an explicit advice policy with reason codes and injects them into an agent's prompt inside a declared untrusted data boundary. It also runs on Windows and Linux, which OpenUsage no longer does since its Swift rewrite.",
    caveat:
      "Four active repositories share this name. The one linked here is the project behind openusage.ai. A cross platform community fork, a terminal dashboard, and two Windows tray ports all exist separately.",
  },
  {
    slug: "claudebar",
    name: "ClaudeBar",
    url: "https://github.com/tddworks/ClaudeBar",
    summary: "The clearest per provider documentation, and explicit remaining quota bands.",
    what:
      "It is a macOS menu bar application that monitors the usage quotas of AI coding assistants. For most providers it runs that vendor's own installed command line tool and reads the result.",
    platform: "macOS 15 or later. Installed with Homebrew, a release download, or from source.",
    licence: "MIT",
    coverage:
      "Claude, Codex, Gemini, GitHub Copilot, Antigravity, Z.ai, Kimi, Kiro, Amp, OpenCode Go, Oh My Pi and Grok.",
    source:
      "Mixed, and documented per provider: mostly by running each vendor's command line tool, plus a local database for OpenCode Go, local credentials for Grok, and an optional browser cookie path for Kimi.",
    strength:
      "It documents exactly how every single provider is read, which is rarer than it should be, and it publishes explicit remaining quota bands: healthy above 50%, warning between 20 and 50, critical below 20, depleted at zero.",
    difference:
      "There is no documented command line tool, JSON export or local endpoint, so nothing downstream can consume what it shows. It is a display surface for human eyes. Its per provider reliance on each vendor tool being installed also means coverage quietly shrinks on a machine that lacks them.",
    caveat:
      "A second repository carries a near identical description. Whether it is a fork, a mirror or an independent project was not confirmed, so use the repository linked here.",
  },
  {
    slug: "codexbar",
    name: "CodexBar",
    url: "https://github.com/steipete/CodexBar",
    summary: "The widest provider coverage anywhere, and a real scriptable command line tool.",
    what:
      "It is a small macOS menu bar application that keeps every AI coding provider's usage window, credits and reset countdown visible without a login step. A companion command line tool ships alongside it.",
    platform:
      "macOS 14 Sonoma or later for the application, with command line builds for macOS and Linux. Community integrations exist for Waybar, GNOME, KDE Plasma and Cinnamon.",
    licence: "MIT",
    coverage:
      "Its README claims 69 providers, among them Codex, OpenAI, Claude, Cursor, Gemini, Copilot, Grok, AWS Bedrock and LiteLLM.",
    source:
      "Both, and opt in. It reuses provider sessions you already have, whether OAuth, a device flow, an API key, a browser cookie or a local file, with on device parsing by default and cookies only when you ask.",
    strength:
      "Nothing else here comes close on coverage, and it is the only tool with a genuine scriptable interface: configuration, cost reporting and a serve command, with JSON output and Linux builds, so it runs in continuous integration.",
    difference:
      "That command line tool is built for configuration, cost reporting and feeding a status bar, not for handing an agent a bounded budget. Nothing in it turns a remaining percentage into advice a coding agent acts on. The visual product is macOS only.",
    caveat:
      "An unrelated project of the same name exists: a Bash widget for Waybar on Linux. It is a different program by a different author.",
  },
  {
    slug: "usagemaster",
    name: "UsageMaster",
    url: "https://apps.apple.com/us/app/usagemaster-ai-usage-tracker/id6772029068?mt=12",
    summary:
      "The only one that recommends a next action, and the only one that is not open source.",
    what:
      "It is a macOS menu bar application that brings usage and reset times for several coding tools into one view and then makes a recommendation. Its store listing says it compares your current quota state and helps you decide whether to keep running, wait for a reset, or switch tools.",
    platform: "macOS 15 or later, from the Mac App Store. Mac only.",
    licence:
      "Not stated, and no public source repository was found. Free to download with a one time paid tier.",
    coverage: "Claude Code, Codex, Gemini CLI, OpenCode Go and Cursor.",
    source:
      "Both. It states that Claude Code, Codex and OpenCode Go usage is read from local files and not sent anywhere, while Cursor is fetched with a cookie you save in the keychain yourself.",
    strength:
      "It acts on the numbers rather than only rendering them. Comparing providers side by side and recommending which tool to use right now is the same problem OpenLimiter's advice policy exists to solve, and UsageMaster shipped a polished version of it first.",
    difference:
      "It is closed source, single platform, and covers five providers, with no documented programmatic output at all, so its recommendation lives inside its own window. OpenLimiter's advice is a machine readable block a running agent consumes, and the whole thing is Apache 2.0 and auditable.",
    caveat:
      "This is the one entry here that is not open source, so the claims above come from its store listing rather than from code anyone can read.",
  },
];

/** Every honest comparison needs this line, and it belongs on the page. */
export const COMPARISON_NOTE =
  "These notes were read off each project's own repository, README or store listing in August 2026. Software moves, so check the source before you rely on any of it, and open an issue if something here has gone stale or is simply wrong.";

export function findAlternative(slug: string): Alternative | undefined {
  return alternatives.find((entry) => entry.slug === slug);
}
