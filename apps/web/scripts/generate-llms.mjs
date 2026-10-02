import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const outputUrl = new URL("../public/llms.txt", import.meta.url);

export async function readSite() {
  const source = await readFile(new URL("../lib/site.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return import("data:text/javascript;base64," + Buffer.from(outputText).toString("base64"));
}

function dollars(price) {
  if (!/^\$\d+(?:\.\d+)?$/.test(price)) throw new Error("Expected a USD site price: " + price);
  return price.slice(1);
}

// This template preserves the original document. Shared facts come from site.ts.
export function generateLlms(site) {
  return `# ${site.SITE_NAME}

> ${site.SITE_NAME} is a local first quota meter for AI coding subscriptions. It reads the quota your own machine already knows about, keeps every number bounded, and gives coding agents a budget context block they can act on.

Version ${site.CURRENT_VERSION}. Licence: Apache 2.0. Site: ${site.SITE_URL}

When you hold several AI coding subscriptions at once, the scarce resource stops being money and becomes quota. You have already paid. The question is which of the windows you paid for still has room in it, and ${site.SITE_NAME} puts that answer in front of you and the agent that is spending it, as bounded state rather than prose.

## Get started

Bars are free and need no account. \`npx openlimiter\`, or a permanent install with \`npm install -g openlimiter\` then \`openlimiter\`, walks the same three steps everywhere: sign in, connect, show bars in. Sign in prints a short code and a link to ${new URL(site.SITE_URL).host + "/app/cli"}, so the terminal never sees a password, and any step can be skipped. The desktop app's first run draws the same three steps in its own window: create an account or skip it, connect, then bars in the tray. The hub at ${site.SITE_URL}/app is account first: sign in with GitHub, Google, Microsoft, or a magic link, then connect, then bars.

An account only adds sync: the current percentage on every window, kept current between every device you sign into. Pro adds history, alerts, the phone, more than one account per provider, and cloud metering for API spend keys, opened by a 30 day free trial with no card required.

## Terminal

Claude Code, Grok Build and the Antigravity CLI each draw bars through their own status line. Codex draws its own built in items instead, because a command is the only surface it exposes. Gemini CLI, OpenCode, Kimi and any other terminal read a shell prompt segment. \`openlimiter terminal\` wires whichever hosts a machine supports and \`--yes\` wires every one of them at once; \`openlimiter terminal install <host>\` and \`terminal uninstall <host>\` wire or restore one host by name. \`openlimiter terminal show <provider>\` and \`terminal hide <provider>\` pick which connected providers actually draw a bar. On Claude Code the line opens with the model, the effort and the context window; the folder appears only after \`openlimiter terminal show dir\`. Each cell reads as a tag, a ten block bar, the percentage, and the reset time. A \`~\` before a value marks a reading three minutes old or more, or an estimate, and a provider that cannot be measured right now is left out of the line.

## Connect

Each provider is read from the login its own tool already stored on disk, at most once every fifteen minutes. Codex can also sign in from inside ${site.SITE_NAME}, into an account it manages, never touching your own Codex configuration. Claude reads what Claude Code reports through its own status line automatically, with an opt in poll of Anthropic's own usage endpoint, off by default, for when Claude Code is closed. Gemini CLI and Antigravity are read only, each with a plain disclosure sentence in its row, because their vendors' terms bar a third party from proxying that login. OpenRouter signs in with real OAuth, started from the hub; a key you already hold still works. API spend keys, separate from a subscription login, live in this device's operating system keyring by default, or, with opt in cloud metering, encrypted on the server, so the hub and the phone can show spend with no device running.

${site.SITE_NAME} never asks for a vendor password: every sign in happens on that vendor's own page, in your own browser. It never impersonates a vendor tool: every request identifies itself as ${site.SITE_NAME}, never as Claude Code, Codex, or any other client. It never uploads a token: an account syncs the bounded percentages and reset times these readings produce, never the credential that produced them.

## Terminal sign in

\`openlimiter login\` signs a terminal into your account by device code, approved at ${new URL(site.SITE_URL).host + "/app/cli"}; \`--open\` also opens that link in a browser. \`openlimiter sync\` uploads one round of cached bars to the hub, and \`refresh\` already triggers this on its own after a successful round when a session exists. \`openlimiter whoami\` prints the signed in account and this device's id. \`openlimiter logout\` forgets the session on this device.

## What ships today

- Command line tool, published on npm as \`openlimiter\`. Install it with \`npm install -g openlimiter\`, or run it once with \`npx openlimiter\`. Commands include setup (the default), login, logout, whoami, sync, init, snapshot, statusline, terminal, refresh, hook, hooks, status, ingest, config, doctor, demo, and export.
- Desktop tray application for Windows, macOS and Linux, built on continuous integration and attached to the GitHub release. All three ship unsigned for now. In SmartScreen, choose More info, then Run anyway. On macOS, open the app once, then System Settings, Privacy and Security, Open Anyway.
- Web hub at ${site.SITE_URL}/app, account first: sign in, connect, bars. Signed in, it shows the bounded percentages your own devices synced.
- Progressive web app. The hub installs to a phone or desktop home screen from the browser and keeps working offline.
- An account, with sign in through GitHub, Google, Microsoft, or a magic link sent to your email address. Sync is on from the moment you sign in. It syncs bounded quota readings and nothing else.
- Phone access by QR pairing from the hub, nothing typed. Add it to a home screen from there: Android offers to install it, iOS uses Share, then Add to Home Screen. A Pro surface.
- Agent adapters that inject the bounded budget block, installed with \`openlimiter hooks install <agent>\`.

## Pro

Pro costs ${dollars(site.PRO_MONTHLY_PRICE) + " US dollars"} a month or ${dollars(site.PRO_YEARLY_PRICE) + " US dollars"} a year, with the first 30 days free and no card required. ${site.SITE_NAME} Pro is sold by ${site.AUTHOR_NAME}. Checkout runs through Stripe, which acts as the payment processor. A full refund is available on request within 14 days of any charge, and cancellation is self service through the Stripe Customer Portal.

Pro adds: every alert (desktop, email and push at 60, 80 and 90 percent of a window, and on reset); ninety days of history with a burn rate forecast; the phone; more than one account per provider; and cloud metering for API spend keys, which the free plan tracks up to 100 US dollars a calendar month for each source without.

Moonshot is read as a balance rather than as spend: three separate figures, available, voucher and cash, in the currency the provider states. A balance never becomes a monthly figure, a forecast, or a budget alert.

## What it never does

- No telemetry from the application. The desktop app, the command line tool and the web app send nothing beyond what connecting and syncing requires.
- The website counts page views without cookies, through Vercel Web Analytics. No profile is built and nothing follows a reader to another site.
- No collection, storage or forwarding of provider credentials. They stay in your operating system keyring, or, only for an API spend key under opt in cloud metering, encrypted on the server, and are sent only to the provider or the hosted metering job that needs them.
- No writing to what it reads. Every reader opens what your installed tools already stored, read only, and never rewrites, repairs or migrates it.
- No automatic routing. ${site.SITE_NAME} produces advice. It does not switch a request, bypass a limit, or touch how an agent authenticates.
- No invented numbers. When a shape changes, reading fails closed: that provider returns to unknown, the others are unaffected, and unknown never becomes zero.

## Connectors

Nine ship in ${site.CURRENT_VERSION}. Every one is marked UNVERIFIED, which means no explicit verifier has confirmed its shape against a live account. \`openlimiter refresh\` reaches the network for the six connectors that read their own login; the rest are parsers over something already local.

- \`claude\`: reads the Claude Code status line automatically, plus an opt in poll of Anthropic's usage endpoint. Native payload and documented API. Low automation risk.
- \`openrouter\`: real OAuth from the hub, then a documented key and usage report. Low automation risk.
- \`codex\`: reads documented limits through the local Codex app server. ChatGPT authentication stays inside Codex.
- \`antigravity\`: read only, from the credential the Antigravity CLI stored. Internal endpoint. May break without notice.
- \`gemini_cli\`: read only, from the login the Gemini CLI stored. Internal endpoint. High automation risk.
- \`grok\`: reads the login the Grok CLI stored, with its weekly credit window. Internal endpoint. High automation risk.
- \`kimi\`: reads the login the Kimi CLI stored, with its weekly summary and five hour limit. Internal endpoint. High automation risk.
- \`opencode\`: reads a usage view behind a session you already signed in to, imported through \`openlimiter ingest --provider opencode\`. Authenticated page. High automation risk. May break.
- \`manual\`: reads numbers you write yourself. Manual entry. Never breaks, never guesses.

## Documentation

- [Getting started](${site.SITE_URL}/docs): sign in, connect, and see your bars in a few minutes.
- [Why ${site.SITE_NAME}](${site.SITE_URL}/docs/why-openlimiter): the problem it addresses, and why quota rather than cost.
- [Supported providers](${site.SITE_URL}/docs/providers): the nine connectors, how you connect each one, and what it reads.
- [Connections](${site.SITE_URL}/docs/connections): what each connection state and source chip actually means.
- [Ingestion](${site.SITE_URL}/docs/ingestion): the offline paths that put quota data in front of ${site.SITE_NAME}.
- [Agent context](${site.SITE_URL}/docs/agent-context): the terminal hosts, the bar grammar, and what reaches a coding agent.
- [Configuration](${site.SITE_URL}/docs/configuration): the state directory, the configuration file, the cache, and the agent settings.
- [CLI reference](${site.SITE_URL}/docs/cli): every command, with its flags, its output and its exit codes.
- [Security and privacy](${site.SITE_URL}/docs/security): what is guaranteed, what is deliberately not done, and how to report a problem.
- [Roadmap](${site.SITE_URL}/docs/roadmap): what is shipped and what remains planned.

## Other pages

- [Home](${site.SITE_URL}): what the tool is, what it reads, and what reaches an agent.
- [Pricing](${site.SITE_URL}/pricing): what is free, what Pro costs, and what each paid line actually is.
- [Web app](${site.SITE_URL}/app): the account first hub, which shows the bars your signed in devices synced.
- [Download](${site.SITE_URL}/download): every way to get it, each row carrying its real state.
- [Privacy](${site.SITE_URL}/privacy): what is collected, where it goes, and how long each thing is kept.
- [Terms](${site.SITE_URL}/terms): the rules for the site and the software, and the billing, cancellation and refund terms.
- [Blog](${site.SITE_URL}/blog): occasional writing about the design and its limits.
- [Changelog](${site.SITE_URL}/changelog): every released version, rendered from the repository's own file.

## Project

- [Source repository](${site.REPO_URL}): the code, the issues, and the discussions.
- [Releases](${site.RELEASES_URL}): packaged builds for every platform.
- [npm package](https://www.npmjs.com/package/openlimiter): the published command line tool.
- [Licence](${site.LICENSE_SPDX_URL}): Apache 2.0.

Author: ${site.AUTHOR_NAME}, ${site.AUTHOR_SITE}
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await writeFile(outputUrl, generateLlms(await readSite()), "utf8");
}
