# Provider marks

Each file in this directory is one provider's identity mark, drawn as a single
`24 x 24` SVG on `currentColor` unless the mark is officially multi colour. The
files are the canonical artwork. `../provider-row.ts` inlines the same drawing
so the shared row renders inside a shadow root with no network request, and
`../../test/provider-marks.test.ts` fails the build if the two ever drift.

## Compatibility and trademark note

This exact sentence accompanies every surface that displays these marks, on the
desktop window, the tray popover and the site:

> Product names, logos, brands, and other trademarks featured or referred to
> within OpenLimiter are the property of their respective trademark holders.
> These trademark holders are not affiliated with OpenLimiter, our products, or
> our website. They do not sponsor or endorse OpenLimiter. Use of them does not
> imply any affiliation with or endorsement by them.

OpenLimiter reads a quota a person already pays for, on that person's own
machine, with that person's own credential. The marks appear for one reason: so
a row can be recognised at a glance as the account it belongs to. They are used
nominatively, never as a claim of partnership.

## Sources and usage rules

| File | Provider | Brand source | Minimum size | Background | Monochrome | Brand colour |
| --- | --- | --- | --- | --- | --- | --- |
| `claude.svg` | Anthropic Claude | https://www.anthropic.com | 16px | Dark and light surfaces | Yes | `#D97757` |
| `codex.svg` | OpenAI Codex | https://openai.com/brand | 16px | High contrast surface | Yes | `#FAFAFA` |
| `gemini.svg` | Google Gemini | https://gemini.google.com | 18px | Gradient mark, keep the gradient | No | `#4E82EE` |
| `antigravity.svg` | Google Antigravity | https://antigravity.google | 18px | Four colour Google mark, keep all four | No | `#EA4335` |
| `opencode.svg` | OpenCode | https://opencode.ai | 16px | Neutral tile | Yes | `#FAFAFA` |
| `openrouter.svg` | OpenRouter | https://openrouter.ai | 16px | Dark and light surfaces | Yes | `#FAFAFA` |
| `grok.svg` | xAI Grok | https://x.ai | 16px | Pure black or pure white | Yes | `#FAFAFA` |
| `kimi.svg` | Moonshot Kimi | https://www.moonshot.cn | 16px | Dark and light surfaces | No | `#007CFF` |
| `manual.svg` | OpenLimiter manual entry | This repository | 16px | Any product surface | Yes | product accent |

`manual.svg` is OpenLimiter's own, for a reading a person typed in by hand. It
carries no third party trademark.

## The accent rule

A provider's brand colour is allowed on exactly two things: its own mark, and a
hairline accent on the card that mark heads. It is never allowed on a quota
meter. A bar's colour answers how much headroom is left, so it belongs to the
five band scale in `../tokens.css` and to nothing else. A Claude bar turning
`#D97757` would be saying "Claude" in the one place the interface has to say
"nearly out".

## Drawing rules

* One `viewBox="0 0 24 24"`, no width or height attribute, so a consumer sizes
  the mark with CSS.
* `fill="currentColor"` on a monochrome mark. It inherits the row's colour and
  therefore stays legible in both themes without a second file.
* Multi colour marks name their stops through product variables with the
  official hex as the fallback, so the artwork is correct standalone and
  themable inside the product.
* No embedded raster, no external reference, no font. The file is geometry.
* `aria-hidden="true"`: the provider's name is already text beside the mark, so
  announcing the artwork would only repeat it.

## Provenance

These are the marks the product already shipped, promoted here from inline
strings to files so the artwork, its sources and its usage rules live in one
reviewable place. No third party asset was fetched, hotlinked or embedded from
a brand site to produce them.
