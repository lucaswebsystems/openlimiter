# Translating OpenLimiter

Read this before touching `pt-BR.json`, `es.json`, `de.json` or `ja.json`.

`en.json` is the source of truth. Every other catalog carries exactly the same
key paths, no more and no fewer, and `node scripts/check-i18n.mjs` fails the
build when that stops being true. Never add a key, never remove one, never
rename one. If English needs a new key, English gets it first.

## 1. The typography rule, and it applies in every language

**No dashes of any kind in translated prose.** No em dash, no en dash, no hyphen
joining words inside a sentence. Use a comma, a colon, a period, parentheses, or
reword the sentence. This is the founder's standing rule for every word this
project publishes and it does not relax because the language changes.

The carve out is technical strings: a file path, a command, a flag, a CSS class,
a URL, a code identifier. Those keep their hyphens because they are not prose.

German compounds are the case that needs thought. Write the compound closed
(`Kontingentanzeige`) or split the sentence, rather than reaching for a hyphen.

## 2. Terms that are never translated

These are product, company and interface names. They appear in the target
language exactly as they appear in English, unchanged, uninflected where the
language allows it.

**The product and its parts**

    OpenLimiter          OpenLimiter Pro      statusline
    quota                meter

`quota` and `meter` stay in English because they are this product's two nouns.
The whole tool is a quota meter, the documentation is written around those two
words, and a reader searching for either has to find the same word on every
page. Explain them in the surrounding sentence if a language needs it, but do
not substitute a local synonym.

**Providers, agents and tools**

    Claude               Claude Code          Codex
    Codex CLI            OpenRouter           Antigravity
    OpenCode             Gemini               Copilot
    Cursor               Perplexity           Mistral
    DeepSeek             Kimi                 Ollama
    LM Studio            Together             xAI

**Platforms and services**

    GitHub               GitHub Sponsors      Buy me a coffee
    npm                  Vercel               Supabase
    Windows              macOS                Linux
    iOS                  Android              SmartScreen
    Gatekeeper           Apache 2.0

**Interface and technical vocabulary that is a name rather than a word**

    connector            ingest               manual entry
    UNVERIFIED           unknown              agent context block
    prompt hook          smart limiter

`connector`, `ingest` and `unknown` are the product's own vocabulary: each one
names a specific thing the interface shows, and the documentation defines them.
Where a language badly needs a gloss, translate the sentence around the term and
leave the term.

`UNVERIFIED` is rendered in capitals by the interface. Keep it in capitals and
keep it in English: it is a status value, not an adjective.

## 3. Prices, numbers and dates

Never edit a price. `$5` monthly and `$50` yearly come from `lib/site.ts`, so a
translation supplies only the sentence around each value. The thirty day trial
is a duration, not a discount percentage or a countdown.

Same for `{count}`, `{name}` and every other brace. A plural looks like this and
the inner structure is ICU rather than prose:

    "OpenLimiter on GitHub, {count, plural, one {# star} other {# stars}}"

Translate the words inside the braces. Keep `#`, keep the keywords `plural`,
`one` and `other`, and add the plural categories your language actually needs
(`few`, `many`, `zero`) where the rules require them. Japanese needs only
`other`.

The public contract is `$5` monthly or `$50` yearly, with the first thirty days
free. Do not add another price, a discount percentage, an end date, or a
countdown that the English does not have.

## 4. Tags inside a message

Some messages carry tags, because the sentence has a link or a piece of inline
code in the middle of it:

    "docsLine": "Both of those are written up in full: <agentContext>what an agent is told</agentContext> and <cli>every command it ships with</cli>."

The tag names are code. Keep every one, spelled identically, opened and closed.
What you translate is the words, including the words inside the tags, and you are
free to move a tag to wherever the sentence needs it in your language. A missing
or renamed tag throws at render time.

## 5. What the tone is

The English copy is plain, declarative and specific, and it never claims
something the product does not do. Several sentences exist purely to say what
OpenLimiter refuses to do: local mode sends nothing to OpenLimiter, provider
credentials never enter Pro, it does not execute a route for you, and it does
not invent a number it does not have. Pro sends only selected bounded quota
snapshots after an explicit sign in.

Translate that flatly. Do not soften a refusal into a promise, do not add
marketing enthusiasm the English does not have, and do not turn a hedge into a
certainty. If English says a connector may break, the translation says it may
break.

Address the reader directly, in the register that language uses for developer
documentation: `você` in Brazilian Portuguese, `tú` in Spanish, `du` in German,
plain polite form in Japanese. Be consistent across the whole catalog.

## 6. The one namespace with a special rule

`localeOffer` is written in its own language, in every catalog. It is the banner
that offers a reader the site in their language, and it appears on a page in a
different language, so `pt-BR.json` holds Portuguese even when the page around it
is English. Those three strings are already filled in for all five locales and
should be reviewed rather than rewritten.

Everything else in a locale file is that locale's translation of the English
sentence at the same key.

## 7. Before you hand it back

    node scripts/check-i18n.mjs

Run it from `apps/web`. It fails on a missing key, an extra key, an empty value,
a key that is a sentence in one language and a group in another, and any message
whose ICU arguments or tags do not match the English one. It prints how much of
each catalog is still identical to English, which is how you can see what is
left.

Then remove the `_status` note from the top of the file you finished. It is there
to say the catalog is an untranslated placeholder, and it stops being true.
