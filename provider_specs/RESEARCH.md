# Provider capability research

Twelve providers, researched against official documentation only. A forum
post was allowed to point at where an official page might live, never cited
as the source of a fact. Where an official page could not be reached (a few
consumer marketing pages returned HTTP 403 to automated fetching), that is
stated plainly and the claim is marked inferred or unknown rather than
presented as read.

Access date for every claim below is 2026-08-10 unless a different date is
shown next to a specific source. Reviewed_at in every new spec file is also
2026-08-10.

Each provider is answered against the same five questions:

1. Does an official API exposing usage, quota, credits, or spend exist.
2. Does the local tool write anything readable on disk that carries quota or
   usage state.
3. What subscription tiers and limit windows are documented.
4. Classification: official_api, local_file, scrape_only (unsupported
   automatic), no_quota_concept, or manual_only.
5. Confidence: verified_docs, inferred, or unknown.

## A schema note before the twelve

`scripts/validate-provider-specs.mjs` requires every spec to carry at least
one meter; an empty list fails validation. That is a real constraint on a
registry entry, not a claim that real quota data exists. Four of the twelve
specs below carry a meter that is a placeholder rather than working
telemetry, and each says so in its own file comment and again here:

- Ollama and LM Studio are no_quota_concept: their one meter is a model
  capability, context length, not a usage counter, and is marked optional.
- Perplexity and Together AI are scrape_only: their one meter routes through
  the manual reader that `packages/connectors/src/manual.ts` already
  implements, the same contract a human typing a dashboard number into
  OpenLimiter would use, and is marked optional.

No meter in any of the twelve new specs was invented against an endpoint or
file that documentation does not name.

---

## 1. Perplexity

**1. Official API.** No. The full API reference lists only `POST /v1/agent`;
no account, usage, or billing GET endpoint exists in it
(https://docs.perplexity.ai/api-reference, accessed 2026-08-10). Balance and
usage appear only in the console at `console.perplexity.ai/group/billing`
(credit balance, usage chart, per model billing breakdown, invoice history),
and the API organization guide confirms there is no programmatic access to
that data, console only
(https://docs.perplexity.ai/guides/api-organization, accessed 2026-08-10).
Every `/v1/agent` response does carry a real per request `usage` object
(`input_tokens`, `output_tokens`, `total_tokens`, a nested `cost` block, and
more), but that is per call telemetry, not an account balance check
(https://docs.perplexity.ai/docs/agent-api/quickstart, accessed 2026-08-10).

**2. Local file.** Not documented. Perplexity's API and Pro products are
cloud only; no official CLI or desktop tool with a documented local config
or session file was found.

**3. Tiers and windows.** The API side has no subscription tiers by
Perplexity's own words: it is consumption and credit billing instead, with
six rate limit tiers keyed to cumulative lifetime spend that never
downgrade: Tier 0 at $0, Tier 1 at $50, Tier 2 at $250, Tier 3 at $500, Tier
4 at $1,000, Tier 5 at $5,000
(https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers, accessed
2026-08-10). Pricing: Search API $5.00 per 1,000 requests; Sonar $1 per 1M
tokens in or out; Sonar Pro $3 in, $15 out; Sonar Reasoning Pro and Sonar
Deep Research $2 in, $8 out; Embeddings $0.004 to $0.05 per 1M tokens
(https://docs.perplexity.ai/docs/getting-started/pricing, accessed
2026-08-10). The consumer side, Free, Pro, and Max plans, could not be
fetched directly: `www.perplexity.ai/help-center/*` and
`perplexity.ai/hub/pricing` returned HTTP 403 on every attempt. Numbers
commonly reported for Pro and Max (around $200 a month for Max, a stated
10,000 monthly credits for a "Perplexity Computer" feature) come from search
indexing of those same official pages, not a direct read, and are marked
inferred rather than verified below.

**4. Classification: scrape_only** (unsupported automatic). Real credit and
usage data exists, in the console for the API and in account settings for
the consumer app, but no documented API or local file exposes either.

**5. Confidence: verified_docs** for the API product structure, tiers, rate
limits, pricing, and per response usage fields. **Inferred** for consumer
Pro and Max pricing and limit language, since those pages could not be
fetched directly.

Sources: https://docs.perplexity.ai/api-reference ·
https://docs.perplexity.ai/guides/api-organization ·
https://docs.perplexity.ai/docs/agent-api/quickstart ·
https://docs.perplexity.ai/docs/admin/rate-limits-usage-tiers ·
https://docs.perplexity.ai/docs/getting-started/pricing ·
https://docs.perplexity.ai/docs/resources/faq ·
https://docs.perplexity.ai/docs/getting-started/api-groups
(all accessed 2026-08-10; `www.perplexity.ai/help-center/*` and
`perplexity.ai/hub/pricing` attempted, blocked with HTTP 403)

---

## 2. xAI (Grok)

**1. Official API.** Yes, the strongest official_api case in this whole
research pass. A separate Management API at `management-api.x.ai` is
distinct from the inference API and needs a separate management key created
in the xAI console under Settings, Management Keys, not the normal
inference API key
(https://docs.x.ai/developers/rest-api-reference/management/auth, accessed
2026-08-10). Confirmed endpoint: `GET
/v1/billing/teams/{team_id}/prepaid/balance`, header `Authorization: Bearer
<Management API Key>`, documented response:

```json
{
  "changes": [
    { "teamId": "...", "changeOrigin": "PURCHASE", "topupStatus": "SUCCEEDED",
      "amount": { "val": "-1000" }, "invoiceId": "...", "invoiceNumber": "...",
      "createTime": "2025-02-24T15:28:02.308840Z",
      "paymentProcessor": { "kind": "STRIPE" } }
  ],
  "total": { "val": "-1000" }
}
```

A second endpoint, `POST /v1/billing/teams/{team_id}/usage`, returns a time
series of consumption grouped by model. Both confirmed at
https://docs.x.ai/developers/rest-api-reference/management/billing, accessed
2026-08-10. Several sibling billing endpoints exist alongside these
(billing info, invoices, payment method, spending limits, prepaid top up),
same page.

**2. Local file.** Not documented. xAI's API is server and console only; no
official CLI or desktop tool with a documented local quota file was found.

**3. Tiers and windows.** API rate limit tiers are keyed to cumulative spend
since 2026-01-01 and never downgrade: Tier 0 at $0, Tier 1 at $50, Tier 2 at
$250, Tier 3 at $1,000, Tier 4 at $5,000, Enterprise on request, with per
model requests per second and tokens per minute limits scaling by tier
(https://docs.x.ai/developers/rate-limits, accessed 2026-08-10). Billing is
prepaid credit balance with an optional postpaid invoiced mode above a
spending limit override (https://docs.x.ai/console/billing, accessed
2026-08-10). Separately, the consumer Grok subscription documents a free
tier plus paid SuperGrok plans that draw from a single shared weekly usage
pool spent across chat, image, video, and voice; xAI's own FAQ explicitly
declines to publish fixed numbers and points users at the account's in app
usage settings instead
(https://docs.x.ai/grok/overview and https://docs.x.ai/grok/faq, both
accessed 2026-08-10). Exact consumer tier names and prices could not be
confirmed: `x.ai/grok`, `x.ai/pricing`, and `grok.com` all returned HTTP 403.

**4. Classification: official_api** for the developer Management API.
**Scrape_only** for the consumer Grok and SuperGrok subscription, since
xAI's own docs decline to publish fixed numbers there.

**5. Confidence: verified_docs** for the Management API endpoints, fields,
auth, and API side rate limits and pricing. **Verified_docs** for the
existence of the consumer weekly pool model and the fact that xAI does not
publish fixed numbers for it. **Unknown** for exact consumer tier names and
prices.

Sources: https://docs.x.ai/developers/rest-api-reference/management ·
https://docs.x.ai/developers/rest-api-reference/management/billing ·
https://docs.x.ai/developers/rest-api-reference/management/auth ·
https://docs.x.ai/developers/management-api-guide ·
https://docs.x.ai/console/usage · https://docs.x.ai/console/billing ·
https://docs.x.ai/overview · https://docs.x.ai/developers/rate-limits ·
https://docs.x.ai/developers/pricing · https://docs.x.ai/grok/overview ·
https://docs.x.ai/grok/faq
(all accessed 2026-08-10; `x.ai/grok`, `x.ai/pricing`, `grok.com` attempted,
blocked with HTTP 403)

---

## 3. Gemini CLI (Google)

**1. Official API.** Not documented for reading quota state.
`ai.google.dev/gemini-api/docs/rate-limits` documents rate limit tiers
(Free; Tier 1 at a $250 cumulative billing cap; Tier 2 at $100 paid plus 3
days; Tier 3 at $1,000 paid plus 30 days) and limit dimensions (RPM, TPM,
RPD, a rolling ten minute spend cap), and points users at the Google AI
Studio dashboard, `aistudio.google.com/rate-limit`, to see active limits.
No programmatic quota check endpoint is mentioned
(https://ai.google.dev/gemini-api/docs/rate-limits, accessed 2026-08-10;
also https://ai.google.dev/gemini-api/docs/pricing, accessed 2026-08-10).

**2. Local file.** Two answers. Configuration and auth files are documented
but do not carry quota numbers: user settings at `~/.gemini/settings.json`,
project settings at `.gemini/settings.json`, system overrides at
`/etc/gemini-cli/settings.json` on Linux,
`C:\ProgramData\gemini-cli\settings.json` on Windows, and
`/Library/Application Support/GeminiCli/settings.json` on macOS
(https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md,
accessed 2026-08-10). Separately, a genuine opt in local usage file does
exist: setting `.gemini/settings.json` to `"telemetry": { "enabled": true,
"target": "local", "outfile": ".gemini/telemetry.log" }` makes Gemini CLI
write OpenTelemetry metrics locally, including a token usage counter
literally named `gemini_cli.token.usage` (tagged by model and type) and a
`gemini_cli.session.count` counter
(https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md,
accessed 2026-08-10). This is disabled by default, and the exact on disk
record format is not stated in the doc. Two commonly known credential cache
file names could not be confirmed in any official doc page and are left as
undocumented rather than assumed.

**3. Tiers and windows.** Gemini CLI documents its own per user per day
request caps by auth method
(https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md,
accessed 2026-08-10, fetched twice for confirmation): Google account OAuth
free login, 1,000 requests per day; Google AI Pro subscription, 1,500 per
day; Google AI Ultra subscription, 2,000 per day; free Gemini API key,
restricted to the Flash model, 250 per day; paid Gemini API key, varies with
the underlying Gemini API's own spend based tiers; Vertex AI Express Mode,
free for 90 days then billed, limits described only as varying; Vertex AI
regular and Workspace Code Assist Standard, 1,500 per day; Enterprise and
Workspace AI Ultra, 2,000 per day. One inconsistency is flagged rather than
resolved: `README.md` in the same repository states the free API key path
gets 1,000 requests per day mixed Flash and Pro, which conflicts with the
dedicated quota and pricing page's 250 requests per day, Flash only, for
what reads as the same auth method. Both are official files in the same
repository; which is current could not be determined without a changelog on
either page.

**4. Classification: local_file**, narrowly. The opt in telemetry file is
real, official, and carries usage state, which is the literal definition
this registry uses. It is not enabled by default, its on disk format is not
pinned down in the docs, and it reports raw token and session counters
rather than a ready made percent of the documented daily cap: a working
parser would need extra logic to relate the two. Absent enabling it, the
honest fallback is closer to scrape_only, since the AI Studio dashboard and
the CLI's own interactive `/stats` output are the only other places quota
appears, and neither persists anywhere by default.

**5. Confidence: verified_docs** for all config paths, the telemetry opt in
mechanism and metric names, the tier and quota table, and the absence of a
quota check API endpoint. The README versus quota and pricing page conflict
on API key daily limits is flagged as unresolved. Two credential cache file
names are marked unknown rather than assumed, since they were found only in
GitHub issue discussion, not in documentation.

Sources: https://github.com/google-gemini/gemini-cli (README.md) ·
https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/authentication.mdx ·
https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md ·
https://github.com/google-gemini/gemini-cli/blob/main/docs/resources/quota-and-pricing.md ·
https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/telemetry.md ·
https://ai.google.dev/gemini-api/docs/rate-limits ·
https://ai.google.dev/gemini-api/docs/pricing
(all accessed 2026-08-10)

---

## 4. GitHub Copilot

**1. Official API.** Yes, at three access levels. Individual user level:
`GET /users/{username}/settings/billing/usage`, `.../usage/summary`,
`.../premium_request/usage`, `.../ai_credit/usage`, header `Authorization:
Bearer <token>`, `Accept: application/vnd.github+json`, applying only when
the user bought their own Copilot plan directly rather than through an
organization
(https://docs.github.com/en/rest/billing/usage, accessed 2026-08-10). The
exact OAuth scope or fine grained token permission required is not stated
on that page: left unknown rather than guessed. Organization and enterprise
levels add usage metrics report endpoints under
`/orgs/{org}/copilot/metrics/reports/*` and
`/enterprises/{enterprise}/copilot/metrics/reports/*`, which return download
links to report files rather than inline numbers, gated by `read:org` or
`manage_billing:copilot` scopes and owner or billing manager permission
(https://docs.github.com/en/rest/copilot/copilot-usage-metrics, accessed
2026-08-10), plus mirrored org and enterprise billing endpoints
(https://docs.github.com/en/rest/billing/usage, accessed 2026-08-10). Sample
individual usage fields: `timePeriod`, `user`, `product`, `model`, and a
`usageItems` array of `product`, `sku`, `model`, `unitType`, `pricePerUnit`,
`grossQuantity`, `grossAmount`, `netQuantity`, `netAmount`.

**2. Local file.** Not documented for usage data. The official CLI config
directory reference names `~/.copilot/settings.json` (personal settings),
`~/.copilot/config.json` (auth and internal state), plus
`copilot-instructions.md`, `permissions-config.json`, `lsp-config.json`,
`mcp-config.json`, a `session-store.db` SQLite file, and `logs/`,
`session-state/`, `command-history-state/`, `installed-plugins/`,
`plugin-data/` subdirectories, all under `~/.copilot/`, overridable with the
`COPILOT_HOME` environment variable
(https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference,
accessed 2026-08-10). None of these are described as holding premium
request or AI credit consumption numbers.

**3. Tiers and windows.** GitHub is mid migration: the billing unit changed
from premium requests to GitHub AI Credits on 2026-06-01, and both terms
still appear across current docs
(https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals,
accessed 2026-08-10). Documented plans and monthly AI credit allotments
(https://docs.github.com/en/copilot/get-started/plans and
https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises,
both accessed 2026-08-10): Free, 2,000 code completions a month plus an
unquantified AI credit allowance; Student, unlimited completions plus an
unquantified allowance; Pro, $10 a month, 1,500 AI credits; Pro+, $39 a
month, 7,000 AI credits; Max, $100 a month, 20,000 AI credits; Business, $19
per user a month, 1,900 AI credits per user; Enterprise, $39 per user a
month, 3,900 AI credits per user. Included credits reset to the full amount
at 00:00:00 UTC on the first of each calendar month and do not carry over.
Code completions and next edit suggestions stay unlimited and are never
billed in credits. Legacy premium request multipliers still apply only to
Pro and Pro+ annual subscribers who stayed on the older request based
billing; that page was not fetched directly, so its exact multiplier
numbers are not cited here.

**4. Classification: official_api.** The only one of the three coding
assistant tools researched, Copilot, Cursor, Windsurf, whose usage endpoint
also works for an ordinary individual user with a normal bearer token rather
than only a team or enterprise administrator.

**5. Confidence: verified_docs** for endpoint paths, auth header shape,
plan names and prices, the credit table, and CLI config paths. **Unknown**
for the exact scope or permission the personal billing endpoint needs, and
for the exact Free tier AI credit number.

Sources: https://docs.github.com/en/rest/billing/usage ·
https://docs.github.com/en/rest/copilot/copilot-usage-metrics ·
https://docs.github.com/en/billing/concepts/product-billing/github-copilot-premium-requests ·
https://docs.github.com/en/copilot/concepts/copilot-billing/requests-in-github-copilot ·
https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing ·
https://docs.github.com/en/copilot/concepts/billing/organizations-and-enterprises ·
https://docs.github.com/en/copilot/concepts/billing/usage-based-billing-for-individuals ·
https://docs.github.com/en/copilot/get-started/plans ·
https://docs.github.com/en/copilot/concepts/billing/individual-plans ·
https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference ·
https://docs.github.com/en/copilot/how-tos/manage-and-track-spending/monitor-ai-usage ·
https://github.blog/news-insights/company-news/github-copilot-is-moving-to-usage-based-billing/
(all accessed 2026-08-10)

---

## 5. Cursor

**1. Official API.** Yes, but scoped to a team, not to an individual solo
subscriber. The Admin API's only documented credential is an API key "tied
to your organization" and "viewable by all admins," created at
`cursor.com/dashboard`, auth as HTTP Basic with the key as the username
(https://cursor.com/docs/account/teams/admin-api and
https://cursor.com/docs/api, both accessed 2026-08-10). Confirmed
endpoints, all POST: `/teams/daily-usage-data` (fields include
`totalLinesAdded`, `composerRequests`, `chatRequests`, `agentRequests`,
`subscriptionIncludedReqs`, `usageBasedReqs`); `/teams/spend` (fields
`teamMemberSpend[]` with `userId`, `spendCents`, `overallSpendCents`,
`monthlyLimitDollars`, `effectivePerUserLimitDollars`, plus
`subscriptionCycleStart`); `/teams/filtered-usage-events` (per event detail
including `chargedCents`, `tokenUsage`); `/teams/user-spend-limit` (write
only, sets a per user cap). A separate Cloud Agents API uses Bearer auth
against `/v1/me` instead of Basic auth, a different credential model. No
endpoint exists for an individual, non admin, no team account to read their
own usage; that shape has no documented API and only the web dashboard at
`cursor.com/dashboard/usage`.

**2. Local file.** Not documented. Cursor's official privacy pages describe
data flows to model providers and encryption and residency policy, but name
no local file path carrying usage or quota numbers
(https://cursor.com/docs/enterprise/privacy-and-data-governance, accessed
2026-08-10). Paths reported in community sources for a local state database
are excluded here as not officially documented.

**3. Tiers and windows.** From `cursor.com/pricing` and
`cursor.com/docs/account/pricing`, both accessed 2026-08-10. Cursor prices
in dollar denominated included usage pools rather than fixed request
counts: Hobby (free), limited agent requests, no published number; Pro, $20
a month, a documented $20 pool for other model usage plus a general agent
allowance with no published fixed count; Pro+, roughly $60 a month with a
$70 other model pool and three times the Pro agent limit (two separate
fetches of this page showed slightly different base price framing, flagged
rather than reconciled); Ultra, $200 a month, a $400 other model pool and
twenty times the Pro agent limit; Teams Standard, $40 per user a month;
Teams Premium, $40 per user a month with five times the Standard limit;
Enterprise, custom, pooled usage. No fixed numeric fast request count is
published anywhere reachable; Cursor frames limits as a monthly dollar pool
with pay as you go overage at API rates instead.

**4. Classification: official_api** for the team level Admin API, the
literal correct bucket for the endpoint itself. In practice this reduces to
**scrape_only** for an individual Hobby or Pro subscriber with no team,
since no personal usage API is documented for that account shape and the
dashboard is the only place personal usage appears. The spec file models
the team level official_api surface and carries this caveat in its header
comment.

**5. Confidence: verified_docs** for all Admin API endpoints, fields, and
auth, cross checked across two fetches with consistent results, and for the
absence of an individual user API and of a documented local quota file.
**Inferred** for the exact Pro+ and Ultra price and pool reconciliation.

Sources: https://cursor.com/docs/account/teams/admin-api ·
https://cursor.com/pricing · https://cursor.com/docs/api ·
https://cursor.com/docs/account/pricing · https://cursor.com/docs/models ·
https://cursor.com/docs/enterprise/privacy-and-data-governance
(all accessed 2026-08-10)

---

## 6. Windsurf (now Devin Desktop, Cognition)

Ownership and branding changed since this provider was named for research.
`windsurf.com` now 308 redirects to `devin.ai`, and `docs.windsurf.com` now
307 redirects to `docs.devin.ai`. Cognition, maker of Devin, confirms in its
own product blog that Windsurf became Devin Desktop effective 2026-06-02,
with the legacy Cascade agent name available only through 2026-07-01
(https://devin.ai/blog/windsurf-is-now-devin-desktop, accessed 2026-08-10).
The underlying infrastructure domain, `server.codeium.com`, is unchanged,
so this is the third brand name over one lineage: Codeium, then Windsurf,
now Devin Desktop. The spec file keeps `provider_id: windsurf` because that
is the name existing subscriptions were bought under and the name this
audit was asked to research, and states the rename in its own header
comment rather than silently following it.

**1. Official API.** Yes, two generations, both Enterprise plan gated.
Generation one: `POST server.codeium.com/api/v1/GetTeamCreditBalance`, a
`service_key` with Billing Read permission passed in the request body,
returns `promptCreditsPerSeat`, `numSeats`, `addOnCreditsAvailable`,
`addOnCreditsUsed`, `billingCycleStart`, `billingCycleEnd`; documented note
that the figures reset every billing cycle rather than being a lifetime
total
(https://docs.devin.ai/windsurf/plugins/accounts/api-reference/get-team-credit-balance,
accessed 2026-08-10). Generation two: `GET
server.codeium.com/api/v2alpha/analytics/consumption`, `Authorization:
Bearer <service_key>`, returns a time series of `prompt_credits`,
`flex_credits`, `billed_acus`, `message_count` grouped by day or month,
rate limited to 10 requests an hour and explicitly stated as "not intended
for real time usage monitoring"
(https://docs.devin.ai/desktop/accounts/api-reference/get-consumption,
accessed 2026-08-10). Both generations are stated plainly as "available for
Enterprise plans only"
(https://docs.devin.ai/desktop/accounts/api-reference/api-introduction,
accessed 2026-08-10); a Free or Pro individual subscriber has no documented
API. A broader Devin Enterprise API also exists under
`api.devin.ai/v2/enterprise/*`; whether it covers Desktop usage specifically
or only the separate cloud agent Devin product was not stated on the page
read, left unknown.

**2. Local file.** Not documented for usage or credit data. The official
Devin Desktop FAQ names `~/.codeium/user_settings.pb`,
`~/.codeium/mcp_config.json`, and
`~/.codeium/windsurf/global_workflows/`, none described as holding credit or
usage numbers (https://docs.devin.ai/desktop/devin-desktop-faq, accessed
2026-08-10). Remaining usage is checked through the in app Plan Info panel
or the web portal at `windsurf.com/subscription/manage-plan`
(https://docs.devin.ai/desktop/accounts/usage, accessed 2026-08-10).

**3. Tiers and windows.** From `devin.ai/pricing` (reached by redirect from
`windsurf.com/pricing`; "Windsurf" does not appear anywhere on the page,
branding is fully Devin and Cognition), accessed 2026-08-10: Free, $0, a
light quota described only qualitatively; Pro, $20 a month, an allowance
that refreshes on both a daily and a weekly basis with no exact number
published on this page; Max, $200 a month, the same refresh language at a
higher allowance; Teams, $80 a month team fee plus $40 a month per seat;
Enterprise, custom. Consumption rule: sending a message to a premium model
consumes one prompt credit, and a failed message consumes none
(https://docs.devin.ai/desktop/accounts/usage, accessed 2026-08-10). Exact
per tier credit or ACU counts were not found on any officially fetched page
despite multiple attempts; numbers reported elsewhere (for example $15 a
month for 500 prompt credits) contradict the official $20 Pro price just
read and are excluded here.

**4. Classification: official_api**, identically to Cursor, gated to
Enterprise plans only. An individual Free or Pro subscriber has no API and
this reduces to scrape_only in practice for that account shape.

**5. Confidence: verified_docs** for the rebrand and its date, both API
generations' endpoints, fields, and auth, the local config paths, and the
absence of an individual user API. **Unknown** for exact per tier credit or
ACU numbers, the generation one `GetUsageConfig` sibling endpoint's response
shape, and whether the v2 Enterprise API covers Desktop usage.

Sources: https://docs.devin.ai/desktop/accounts/usage ·
https://devin.ai/pricing · https://docs.devin.ai ·
https://devin.ai/blog/windsurf-is-now-devin-desktop ·
https://docs.devin.ai/desktop/devin-desktop-faq ·
https://docs.devin.ai/admin/billing ·
https://docs.devin.ai/desktop/accounts/api-reference/api-introduction ·
https://docs.devin.ai/enterprise/api-reference/overview ·
https://docs.devin.ai/windsurf/plugins/accounts/api-reference/get-team-credit-balance ·
https://docs.devin.ai/desktop/accounts/api-reference/get-consumption ·
https://docs.devin.ai/api-reference/authentication
(all accessed 2026-08-10)

---

## 7. Ollama

**1. Official API.** No quota API exists locally, because there is no
account. The local REST API at `http://localhost:11434` does document two
resource state endpoints: `GET /api/ps` (loaded models, fields `name`,
`model`, `size`, `digest`, a nested `details` block, `expires_at`,
`size_vram`) and `POST /api/show` (model detail, whose `model_info` block
uses architecture namespaced keys, for example `"llama.context_length":
8192` for a Llama family model)
(https://github.com/ollama/ollama/blob/main/docs/api.md, accessed
2026-08-10, verified against the raw file). No auth header is shown in any
example. Separately, Ollama Cloud, a paid hosted product, has no documented
usage or quota API at all: an open feature request on Ollama's own
repository, `ollama/ollama#16448`, closed as a duplicate of `#12532`, states
plainly that the web dashboard is the only way to see it
(https://github.com/ollama/ollama/issues/16448, accessed 2026-08-10).

**2. Local file.** Not documented for quota, since none exists locally.
Documented, non quota paths: the `OLLAMA_MODELS` environment variable sets
the model storage directory, default `~/.ollama/models` on macOS,
`/usr/share/ollama/.ollama/models` on Linux,
`C:\Users\%username%\.ollama\models` on Windows
(https://docs.ollama.com/faq, accessed 2026-08-10). `~/.ollama/server.json`
is documented as a feature toggle file for disabling cloud features, not a
usage state file.

**3. Tiers and windows.** Local Ollama is free and unmetered, bound only by
hardware; documented concurrency variables are `OLLAMA_MAX_LOADED_MODELS`
(default three times the GPU count, or three for CPU), `OLLAMA_NUM_PARALLEL`
(default one), `OLLAMA_MAX_QUEUE` (default 512)
(https://docs.ollama.com/faq, accessed 2026-08-10). Ollama Cloud tiers
(https://ollama.com/pricing, accessed 2026-08-10): Free $0; Pro $20 a month
or $200 a year; Max $100 a month, new signups paused at review time; Team
$25 per seat a month, five seat minimum; Enterprise custom. Concurrent cloud
models allowed: one on Free, three on Pro, ten on Max. Verbatim from the
docs: usage limits scale with model and token counts rather than a fixed
token ceiling, and "each plan has session limits that reset every 5 hours
and weekly limits that reset every 7 days," structurally the same window
shape as Claude Code's own rate limits, but with no fixed numbers published
(https://docs.ollama.com/cloud, accessed 2026-08-10).

**4. Classification.** Local Ollama is **no_quota_concept**. Ollama Cloud is
**scrape_only** (unsupported automatic); real usage data exists only at
`ollama.com/settings` with no documented API or file. The spec file models
local Ollama only, and Cloud is not given a separate spec.

**5. Confidence: verified_docs** for both surfaces.

Sources: https://github.com/ollama/ollama/blob/main/docs/api.md ·
https://docs.ollama.com/faq · https://docs.ollama.com/cloud ·
https://ollama.com/cloud · https://ollama.com/pricing ·
https://github.com/ollama/ollama/issues/16448
(all accessed 2026-08-10)

---

## 8. LM Studio

**1. Official API.** No quota API, since there is no account. A local REST
API at `http://localhost:1234` documents `GET /api/v0/models` (list) and
`GET /api/v0/models/{model}` (single model), with confirmed example fields
`object`, `id`, `type`, `publisher`, `arch`, `compatibility_type`,
`quantization`, `state`, and `max_context_length`
(https://lmstudio.ai/docs/developer/rest/endpoints, accessed 2026-08-10).
The field `loaded_context_length` was checked for directly against this
documented example and does not appear anywhere in it; only
`max_context_length` is confirmed real, and this research explicitly
corrects an earlier assumption to that effect. Authentication is disabled
by default; an optional bearer token can be turned on from Developer
settings
(https://lmstudio.ai/docs/developer/core/authentication, accessed
2026-08-10).

**2. Local file.** Documented, but for models and settings, not usage.
`~/.lmstudio` on macOS and Linux, `%USERPROFILE%\.lmstudio` on Windows, with
a `config-presets` subdirectory for saved system prompts and inference
parameters and a `models` subdirectory organized `publisher/model/file.gguf`
(https://github.com/lmstudio-ai/docs/blob/main/0_app/3_presets/index.md and
https://lmstudio.ai/docs/app/advanced/import-model, both accessed
2026-08-10).

**3. Tiers and windows.** None: LM Studio is a free local app with no
account or billing tier system found in official docs. It does document
model lifecycle limits instead of subscription limits: just in time loading
auto loads a model on first request, auto evict is enabled by default and
keeps at most one just in time loaded model in memory at a time, and an
idle unload timer defaults to 60 minutes, settable per request via a `ttl`
field in seconds
(https://lmstudio.ai/docs/app/api/ttl-and-auto-evict, accessed 2026-08-10).

**4. Classification: no_quota_concept.**

**5. Confidence: verified_docs.**

Sources: https://lmstudio.ai/docs/app/api ·
https://lmstudio.ai/docs/developer/rest/endpoints ·
https://lmstudio.ai/docs/developer/core/authentication ·
https://lmstudio.ai/docs/app/api/ttl-and-auto-evict ·
https://github.com/lmstudio-ai/docs/blob/main/0_app/3_presets/index.md ·
https://lmstudio.ai/docs/app/advanced/import-model
(all accessed 2026-08-10)

---

## 9. Together AI

**1. Official API.** No, checked directly across the API reference, the
rate limits page, and both billing pages. The usage limits page states in
its own words that there is no programmatic endpoint for checking usage,
spend, or limits, and recommends planning workloads against response
headers instead
(https://docs.together.ai/docs/billing-usage-limits, accessed 2026-08-10).
The credits page states balance is managed only through dashboard billing
settings, again with no API
(https://docs.together.ai/docs/billing-credits, accessed 2026-08-10). The
only adjacent official signal is the `x-ratelimit-reset` response header,
which appears only on a 429 error and carries a retry delay, not a
remaining quota number
(https://docs.together.ai/docs/rate-limits, accessed 2026-08-10); this does
not clear the bar for official_api.

**2. Local file.** Not documented. Together AI is a remote API service with
no official local tool found.

**3. Tiers and windows.** No free tier: "access to the Together platform
requires a minimum $5 credit purchase," fully prepaid, API access suspended
at a zero balance, credits carry no expiration date
(https://docs.together.ai/docs/billing-credits, accessed 2026-08-10).
Products documented at `together.ai/pricing`, accessed 2026-08-10: Serverless
Inference, pure pay per use priced per model; Provisioned Throughput, fixed
monthly reserved capacity; Dedicated Inference, single tenant GPU instances
by the hour; GPU Clusters, on demand or reserved by the hour; Sandbox and
Storage, metered by vCPU hour, GiB hour, or session; Fine tuning, priced per
token with a minimum $4.00 charge per job. Rate limiting is dynamic per
organization and per model rather than a fixed published number; the older
named Build Tier system (Build Tier 1 through 5, Scale, Enterprise) has been
retired (https://docs.together.ai/docs/billing-usage-limits, accessed
2026-08-10).

**4. Classification: scrape_only** (unsupported automatic). Real balance
and usage data exists only in the authenticated billing dashboard.

**5. Confidence: verified_docs**, for both the pricing and tier facts and
for the confirmed absence of a balance or usage endpoint across every
official page checked.

Sources: https://docs.together.ai/reference ·
https://www.together.ai/pricing · https://docs.together.ai/docs/rate-limits ·
https://docs.together.ai/docs/billing-usage-limits ·
https://docs.together.ai/docs/billing-credits ·
https://docs.together.ai/reference/chat-completions-1 ·
https://docs.together.ai/docs/inference/pricing
(all accessed 2026-08-10)

---

## 10. Mistral AI

**1. Official API.** Yes, but Enterprise plan gated. The Admin API overview
states plainly that it is an Enterprise only feature for organization
administrators, authenticated with a separate Admin API key created in the
Backoffice, never a normal user API key
(https://docs.mistral.ai/admin/admin-api/overview, accessed 2026-08-10).
Confirmed endpoints, header `x-api-key: <Admin API Key>`, base
`api.mistral.ai`: `GET /v1/admin/usage` (query params `month`, `year`,
`workspace_id`, documented to return a consumption breakdown by category,
chat, completion, ocr, audio, connectors, libraries_api, fine_tuning,
vibe_usage, alongside `start_date`, `end_date`, `currency`); `GET /v1/admin/
spend-limit` and its `POST` counterpart; `GET /v1/admin/rate-limit`; plus le
Chat and Vibe usage analytics endpoints scoped by user, agent, workspace, or
organization
(https://docs.mistral.ai/api/endpoint/beta/admin/billing and
https://docs.mistral.ai/admin/admin-api/usage-metrics, both accessed
2026-08-10). No self serve, non admin balance endpoint was found after
checking the API reference, the usage limits page, and the tier and
subscriptions pages: all three explicitly defer actual numbers to the
authenticated dashboard at `admin.mistral.ai`
(https://docs.mistral.ai/admin/billing-usage/usage-limits, accessed
2026-08-10). The exact key inside `/v1/admin/usage` that holds the category
breakdown was not shown in a rendered example on the page read: this is
flagged in the spec file itself as the least certain meter in the registry.

**2. Local file.** Mistral publishes an official CLI, `mistral-vibe`, whose
README documents `~/.vibe/.env` for API keys, `~/.vibe/config.toml` and a
project level `.vibe/config.toml`, `~/.vibe/trusted_folders.toml`, and a
`shell-tool/sessions` directory
(https://raw.githubusercontent.com/mistralai/mistral-vibe/main/README.md,
accessed 2026-08-10). None of these are documented as storing quota,
balance, or usage data.

**3. Tiers and windows.** Two pricing surfaces. Le Chat, the consumer app:
Free; Pro $14.99 a month; Team $24.99 per user a month with a $50 a month
minimum; Enterprise custom; Education $5.99 a month for verified students,
capped at 12 months; all "subject to fair usage limits"
(https://mistral.ai/pricing/, accessed 2026-08-10). The API, La Plateforme:
per token billing, for example Mistral Large at $2 per 1M tokens in and $6
per 1M out, with a 50 percent batch processing discount, and two billing
modes, a default free mode for new accounts and pay as you go beyond it
(https://mistral.ai/pricing/, https://docs.mistral.ai/admin/user-management-finops/tier,
and https://docs.mistral.ai/admin/user-management-finops/subscriptions, all
accessed 2026-08-10). Rate limits are enforced on requests per second and
tokens per minute or per month, applied per organization, returning HTTP
429 when exceeded, but exact numeric thresholds per tier are not published
on any official page found: every relevant page defers to the authenticated
dashboard instead.

**4. Classification: official_api**, with the same caveat as Cursor and
Windsurf: this is an Enterprise only, admin gated surface, not reachable by
a typical individual paid Mistral developer account.

**5. Confidence: verified_docs** for endpoint paths, the auth header name,
and the billing mode names. **Inferred or unknown** for exact numeric rate
limits per tier: their existence is inferred from three separate official
pages all pointing at the dashboard instead of publishing numbers.

Sources: https://docs.mistral.ai/api/ ·
https://docs.mistral.ai/api/endpoint/beta/admin/billing ·
https://docs.mistral.ai/admin/admin-api/usage-metrics ·
https://docs.mistral.ai/admin/admin-api/overview ·
https://docs.mistral.ai/admin/billing-usage/usage-limits ·
https://docs.mistral.ai/admin/user-management-finops/tier ·
https://docs.mistral.ai/admin/user-management-finops/subscriptions ·
https://mistral.ai/pricing/ ·
https://raw.githubusercontent.com/mistralai/mistral-vibe/main/README.md
(all accessed 2026-08-10)

---

## 11. DeepSeek

**1. Official API.** Yes, the cleanest official_api case found in this
entire research pass. `GET https://api.deepseek.com/user/balance`, header
`Authorization: Bearer <key>` (the site wide auth convention; this specific
page's own example did not repeat a curl call with the header, so the
header is confirmed from the API wide documentation rather than shown
locally on this exact page), documented response:

```json
{
  "is_available": true,
  "balance_infos": [
    { "currency": "CNY", "total_balance": "110.00",
      "granted_balance": "10.00", "topped_up_balance": "100.00" }
  ]
}
```

`currency` is `CNY` or `USD`, balances are returned as strings, and
`balance_infos` is a list because an account can hold balance in more than
one currency (https://api-docs.deepseek.com/api/get-user-balance/, accessed
2026-08-10).

**2. Local file.** Not applicable. The `deepseek-ai` GitHub organization
publishes only research and infrastructure repositories (DeepEP, FlashMLA,
DeepGEMM, and others); no official CLI exists
(https://github.com/deepseek-ai, accessed 2026-08-10).

**3. Tiers and windows.** Prepaid balance, pay per token, no free tier
documented: fees are deducted from topped up or granted balance, granted
balance used first
(https://api-docs.deepseek.com/quick_start/pricing/, accessed 2026-08-10).
Example pricing per 1M tokens: deepseek-v4-flash $0.0028 cached input,
$0.14 input, $0.28 output; deepseek-v4-pro $0.003625 cached input, $0.435
input, $0.87 output. Rate limiting is concurrency based rather than requests
or tokens per minute: a request counts as one open connection from send to
completion, capped at 500 concurrent connections for deepseek-v4-pro and
2,500 for deepseek-v4-flash, enforced per account across all keys with
additional per user sub limits at scale, HTTP 429 on excess. No documented
daily or monthly token cap
(https://api-docs.deepseek.com/quick_start/rate_limit, accessed 2026-08-10).

**4. Classification: official_api.**

**5. Confidence: verified_docs** for the endpoint, path, field names, and
example response, all read directly. The exact auth header on this specific
page is confirmed at the API wide level rather than shown locally on the
balance page itself, noted so it is not over claimed as directly quoted
from that one page.

Sources: https://api-docs.deepseek.com/api/get-user-balance/ ·
https://api-docs.deepseek.com/ ·
https://api-docs.deepseek.com/quick_start/pricing/ ·
https://api-docs.deepseek.com/quick_start/rate_limit ·
https://github.com/deepseek-ai
(all accessed 2026-08-10)

---

## 12. Kimi (Moonshot AI)

Domains changed and were verified live by following the redirect rather
than assumed: `platform.moonshot.ai` now 301s to `platform.kimi.ai`
(international), `platform.moonshot.cn` now 301s to `platform.kimi.com`
(China); the API host names, `api.moonshot.ai` and `api.moonshot.cn`, are
unchanged (both redirects confirmed directly, accessed 2026-08-10).

**1. Official API.** Yes, on both regional platforms, at the same path.
`GET /v1/users/me/balance`, base `https://api.moonshot.ai` international or
`https://api.moonshot.cn` China, header `Authorization: Bearer
{MOONSHOT_API_KEY}`, documented response:

```json
{
  "code": 0,
  "data": { "available_balance": 49.58894, "voucher_balance": 46.58893,
    "cash_balance": 3.00001 },
  "scode": "0x0",
  "status": true
}
```

International currency is USD, China currency is CNY, same field shape on
both (https://platform.kimi.ai/docs/api/balance and
https://platform.kimi.com/docs/api/balance, both accessed 2026-08-10). The
semantic difference between `voucher_balance` and `cash_balance` was not
defined in prose on either page read: left unknown. A key issued on one
regional platform is reported not to work against the other platform's
endpoint; this specific claim came from indexed search content rather than
a page directly read, so it is marked inferred rather than verified.

**2. Local file.** Moonshot publishes an official CLI, `kimi-cli`. Its
README documents configuration paths for third party editor integrations,
`~/.config/zed/settings.json`, `~/.jetbrains/acp.json`, `~/.zshrc`, but
names no kimi-cli owned file that stores balance or usage data
(https://raw.githubusercontent.com/MoonshotAI/kimi-cli/main/README.md,
accessed 2026-08-10).

**3. Tiers and windows.** Two separate systems. Developer API rate limit
tiers are keyed to cumulative recharge amount, not a flat subscription, with
identical tier structure and different thresholds by region
(https://platform.kimi.ai/docs/pricing/limits, international, USD, and
https://platform.kimi.com/docs/pricing/limits, China, CNY, both accessed
2026-08-10): six tiers, Tier0 through Tier5, gated at $1 or ¥0 minimum up to
$3,000 or ¥20,000, each raising concurrency, requests per minute, tokens per
minute, and tokens per day ceilings, with Tier1 and above stating unlimited
tokens per day. The consumer Kimi chat app documents four paid membership
tiers with no listed free tier: Moderato $19 a month or $15 a month billed
yearly; Allegretto $39 or $31; Allegro $99 or $79; Vivace $199 or $159
(https://www.kimi.com/help/membership/membership-pricing, accessed
2026-08-10). All tiers "share a single credit pool, metered by token usage,"
scaling from 60 agent credits and 2 concurrent tasks on Moderato to 720
agent credits and 4 concurrent tasks on Vivace, same page. That page also
states Kimi Code carries its own separate five hour and weekly rate limit,
without publishing the exact numbers.

**4. Classification: official_api**, the second cleanest case in this
research pass after DeepSeek.

**5. Confidence: verified_docs** for both balance endpoints, the domain
redirects, the developer rate limit tier tables on both regions, and the
consumer membership tiers, all read directly. **Inferred** for the meaning
of `voucher_balance` versus `cash_balance`, the cross platform key
rejection behavior, and the exact numeric Kimi Code five hour and weekly
limits.

Sources: https://platform.kimi.com/docs/api/balance ·
https://platform.kimi.ai/docs/api/balance ·
https://platform.kimi.ai/docs/pricing/limits ·
https://platform.kimi.com/docs/pricing/limits ·
https://www.kimi.com/help/membership/membership-pricing ·
https://www.kimi.com/help/kimi-api/api-rate-limits ·
https://github.com/MoonshotAI ·
https://raw.githubusercontent.com/MoonshotAI/kimi-cli/main/README.md
(all accessed 2026-08-10, plus direct redirect checks of
https://platform.moonshot.ai and https://platform.moonshot.cn)

---

## Classification table

| Provider | Question 1, official API | Question 2, local file | Classification | Confidence |
|---|---|---|---|---|
| Perplexity | No endpoint, console only | Not documented | scrape_only | verified_docs (API); inferred (consumer) |
| xAI (Grok) | Yes, Management API prepaid balance and usage | Not documented | official_api (API); scrape_only (consumer Grok) | verified_docs |
| Gemini CLI | No quota endpoint | Yes, opt in OpenTelemetry file, disabled by default | local_file | verified_docs |
| GitHub Copilot | Yes, works for an individual user | Not documented for usage | official_api | verified_docs |
| Cursor | Yes, team admin only | Not documented | official_api (team); scrape_only in practice (solo user) | verified_docs |
| Windsurf (Devin Desktop) | Yes, Enterprise plan only | Not documented for usage | official_api (Enterprise); scrape_only in practice (Free or Pro) | verified_docs |
| Ollama | No (local or Cloud) | Not for quota; model paths only | no_quota_concept (local); scrape_only (Cloud) | verified_docs |
| LM Studio | No, no account exists | Not for quota; model and preset paths only | no_quota_concept | verified_docs |
| Together AI | No, confirmed absent | Not documented | scrape_only | verified_docs |
| Mistral AI | Yes, Admin API, Enterprise gated | Not documented for usage | official_api | verified_docs (endpoint); inferred (exact limits) |
| DeepSeek | Yes, self serve, normal API key | Not applicable, no official CLI | official_api | verified_docs |
| Kimi (Moonshot AI) | Yes, self serve, normal API key | Not documented for usage | official_api | verified_docs |

## Top three providers where a real connector is feasible soonest

**1. DeepSeek.** One ordinary API key, one `GET` call, a small confirmed
JSON body. No admin tier, no management key, no team concept, no second
credential type to explain to a user. The only implementation work is
parsing a string typed balance field and picking the right currency entry
out of a one or two item list. Nothing else researched here is this simple.

**2. Kimi (Moonshot AI).** The same shape as DeepSeek, one ordinary API key
and one `GET` call, with a genuinely nested JSON body rather than a
dot named flat key, so the dotted path in the spec is exact rather than
approximated. The only added complexity is picking the right regional host,
`api.moonshot.ai` or `api.moonshot.cn`, which is a one time account level
fact rather than a per request decision.

**3. xAI (Grok).** A fully documented Management API with both a prepaid
balance and a usage time series endpoint, richer than DeepSeek or Kimi's
single balance figure. The added friction is that it needs a second
credential, a management key, separate from the inference API key a user
would already hold, created once in the xAI console. That is still a self
serve step inside an individual developer's own account, not an
organization admin gate, which is what keeps this ahead of GitHub Copilot:
Copilot's individual endpoint is genuinely promising and uses a credential
type GitHub users already commonly hold, but the exact scope or permission
it needs was not confirmed by this research, and GitHub's billing model was
still mid migration from premium requests to AI credits at review time.
Copilot is a strong fourth candidate once that scope is confirmed by trial
against a real token.

Every other official_api case found, Mistral, Cursor, and Windsurf now
Devin Desktop, is real but gated behind an admin or Enterprise credential
that OpenLimiter's most likely individual user will not hold, which is why
none of the three is ranked above despite a documented endpoint existing.

## Surprising findings

**Windsurf no longer exists under that name.** Effective 2026-06-02 it is
Devin Desktop, a Cognition product; `windsurf.com` and `docs.windsurf.com`
both redirect to `devin.ai` domains. Anyone researching this provider from
memory rather than a live fetch would cite a dead brand.

**The two Chinese labs researched have the cleanest developer facing
balance APIs of all twelve providers, cleaner than any Western coding
assistant.** DeepSeek and Kimi both expose a plain `GET`, a normal API key,
and a small JSON body with no admin gate. Every coding assistant company
researched, Cursor and Windsurf and Devin Desktop outright, and Mistral
among the model API companies, gates its usage API behind a team or
Enterprise administrator credential that an individual paid subscriber does
not hold.

**Being an API company is no guarantee of a balance endpoint.** Perplexity
and Together AI both sell metered API access and both, after a direct check
of their full API reference and every billing adjacent doc page, expose
nothing at all: no endpoint, no local file, dashboard only. Together AI in
particular states this in its own words on its own usage limits page.

**Ollama has a second product most people do not think of as a subscription
at all.** Ollama Cloud has named tiers, a $20 and $100 monthly price, and
session and weekly windows shaped exactly like Claude Code's own five hour
and seven day windows, yet an open issue on Ollama's own repository
confirms there is still no way to read it besides the web dashboard.

**GitHub's own docs disagree with themselves on Gemini CLI style daily
caps, in the other direction.** GitHub's billing terminology, not its
numbers, is what is mid change: premium requests became AI credits on
2026-06-01 and both terms coexist in current docs. The genuinely conflicting
numbers were found in Google's own Gemini CLI repository instead, where
`README.md` and the dedicated quota and pricing page state two different
daily caps, 1,000 requests mixed model against 250 Flash only, for what
reads as the same free API key path.

## Four internal connectors, not web research

A follow up to the twelve above. These four document connectors this
repository already ships, `packages/connectors/src/*.ts`, not a provider's
public documentation, so each gets one line rather than the five question
treatment above. Source of truth is the parser code, its fixtures in
`fixtures.ts`, and this repository alone; `reviewed_at` is 2026-08-10 and
`source_status` is provisional on all four, since `docs_url` names a
repository path rather than an https address.

- **Codex** (`openai/codex.yaml`): the parser reads
  `rate_limits.primary_window.used_percent` and `.reset_at` from
  `codex.ts`, an interface OpenAI does not document and that the file's
  own header comment calls unofficial and liable to break; fixture
  `codex.provisional.usage`.
- **Antigravity** (`google/antigravity.yaml`): the parser reads
  `quota.used_percent` and `.reset_at` from `antigravity.ts`, equally
  undocumented and equally called unofficial in its own header; fixture
  `antigravity.provisional.quota`.
- **OpenCode** (`opencode/opencode.yaml`): the parser reads
  `usage.percent` and `.reset_at` from `opencode.ts`, whose own code
  flags its source as an authenticated browser session scrape,
  `UNVERIFIED_AUTHENTICATED_SCRAPE_HIGH_RISK`, the riskiest mechanism of
  the four; fixture `opencode.provisional.usage`.
- **Manual** (`openlimiter/manual.yaml`): the parser reads named entries
  from `manual.ts`, the one format in this batch OpenLimiter owns
  outright rather than reads from another company, marked provisional
  here only because `docs_url` is a repository path rather than an https
  address; fixture `manual.documented.plan`.

Also in this follow up: `windsurf/editor.yaml`'s `display_name` now leads
with the current brand, `Devin Desktop (formerly Windsurf, Cognition)`,
rather than the retired name; the redirect evidence in its source block
and header comment is unchanged.

## Files written

Twelve new specs under `provider_specs/` from the first research pass:
`perplexity/api.yaml`, `xai/api.yaml`, `google/gemini-cli.yaml`,
`github/copilot.yaml`, `cursor/editor.yaml`, `windsurf/editor.yaml`,
`ollama/local.yaml`, `lmstudio/local.yaml`, `together/api.yaml`,
`mistral/api.yaml`, `deepseek/api.yaml`, `moonshot/api.yaml`. Four more from
this follow up: `openai/codex.yaml`, `google/antigravity.yaml`,
`opencode/opencode.yaml`, `openlimiter/manual.yaml`. Sixteen new specs in
total, plus this file. All eighteen specs (the sixteen above and the two
that existed before any of this work, `anthropic/claude-code.yaml` and
`openrouter/api.yaml`) pass `node scripts/validate-provider-specs.mjs`, and
`provider_specs/provider-specs.json` was regenerated with `pnpm specs:emit`
and matches.
