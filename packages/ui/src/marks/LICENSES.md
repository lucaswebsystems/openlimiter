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

## The 2.1 provider marks: each vendor's own file, unmodified

These eight are not drawings of ours. Each is the file the vendor publishes,
fetched on 2026-09-29 from the vendor's own brand kit, press page or site and
kept byte for byte: the digest below is checked by
`../../test/provider-marks.test.ts`, so an edit to one fails the build. The
drawing rules above (a 24 by 24 view box, `currentColor`, no stylesheet) are
rules for our drawings and do not apply to these, because changing a vendor's
file to meet them would be drawing a mark.

Every source is also recorded in the provider's registry spec, in its `mark`
block. None of the eight is drawn anywhere yet: the providers are registered
and switched off, and a row shows a lettered tile until its provider is
switched on. How a surface then draws the file is that provider's decision,
and an image of the file is the safe default, because some of these carry
their own stylesheet or generic ids that would leak into a shared document.

| File | Provider | Official source | Where the source is published | SHA256 |
| --- | --- | --- | --- | --- |
| `synthetic.svg` | Synthetic | https://synthetic.new/favicon.svg | The icon synthetic.new and its documentation site serve. Synthetic publishes no brand kit or press page. A square white tile. | `271da15c7a7596e5a491481ce6b3f3290749e302f87b03d1f0a91cceede7f8e9` |
| `zai.svg` | Z.ai | https://z-cdn.chatglm.cn/z-ai/static/logo.svg | The icon z.ai's own home page links as its shortcut icon, on Z.ai's own content host. Carries an embedded stylesheet. | `07a45e8e35b0b631ed2c68cd1cb041f9721b1ceeb0bd0e34f1459b0304a741c7` |
| `minimax.svg` | MiniMax | https://mintcdn.com/minimax-cac98058/XYzsL2L2ynonu2Q_/logo/light.svg | The light theme logo of platform.minimax.io, MiniMax's developer platform, served by its documentation host. A horizontal lockup, symbol and wordmark: minimax.io publishes its logos as raster only. | `90c43806b801dd6db9bf95613f9a5634cc83a1c7f303ea192eec37d985baa631` |
| `cline.svg` | Cline | https://cline.bot/assets/branding/brand/General%20Logos/Bot/SVG/BOT_LIGHT.svg | The bot icon from the brand page, https://cline.bot/brand | `267e6a8fdc37e3ad3ebedf843584ad1b6b0fe62cde28cfa4c5702006184970bb` |
| `augment.svg` | Augment Code | https://www.augmentcode.com/downloads/augment-cosmos-logos.zip | The press kit augmentcode.com links, entry `augment/white.svg`. A square light tile. | `f0b6b8f09e2fa7293214c6a3076dfcfe8a265a9c1ad56455cb36831db6027da7` |
| `amp.svg` | Amp | https://ampcode.com/app-icon.svg | The App Icon under Brand Assets on https://ampcode.com/press-kit | `40c79d8c7baa04c2fee214cc1c66a9797eb6aa96bec6c5b20c7d12cd66490696` |
| `kilo.svg` | Kilo Code | https://kilo.ai/favicon/favicon.svg | The icon kilo.ai and its press page serve. The logo its structured data names is white only and carries a stylesheet, so the tile was kept. | `0e8115fe04e4bb07a2122cb66ddc718a7cdfb18fdcfa020bf5dfb51fd92d75e9` |
| `copilot.svg` | GitHub Copilot | https://brand.github.com/GitHub_Logos.zip | GitHub's brand toolkit logo files, entry `GitHub Logos/SVG/Copilot_Icon_Black.svg` | `d5aa364673444e6158fedb206efa2aa71886b465921d8911de3cb4e7a3a951bc` |
