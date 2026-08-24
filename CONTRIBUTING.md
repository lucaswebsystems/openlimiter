# Contributing to OpenLimiter

OpenLimiter accepts small, evidence backed changes. A correct unknown state is always better than a plausible number.

## Before you begin

1. Use Node 24.15.0, pnpm 9.15.0, the stable Rust toolchain, and the platform packages required by Tauri 2.

2. Read [SECURITY.md](SECURITY.md), [BRAND.md](BRAND.md), and the relevant file under `provider_specs` before changing a reader or interface.

3. Keep provider credentials, cookies, OAuth tokens, account identifiers, raw provider responses, local paths, and private service code out of commits and issues.

4. Open an issue before a broad behavior or product boundary change. A focused defect fix can go directly to a pull request when its proof is clear.

## Development loop

1. Install dependencies with `pnpm install --frozen-lockfile`.

2. Run the focused test nearest your change while you work.

3. Build generated desktop UI files with `pnpm --filter @openlimiter/desktop build:ui` after changing a shared engine, token, component, or desktop source file.

4. Run the complete local battery before requesting review.

```powershell
pnpm check:node
pnpm test
pnpm typecheck
pnpm --filter @openlimiter/web lint
pnpm --filter @openlimiter/web build
pnpm --filter @openlimiter/desktop build:ui
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

5. Run `pnpm test:brand` after any asset, header, favicon, PWA, installer, tray, or icon pipeline change. The 87 generated outputs are frozen to the canonical artwork. A change to the canonical file requires recorded owner approval and a regenerated manifest.

## Provider work

1. Start from the provider documentation and record the source in `provider_specs`.

2. Keep every documented window separate. A subscription window is a percentage bar. An API provider uses spend against a configured ceiling, or a neutral spent and remaining credit row when no ceiling exists.

3. A fixture must be documented, sanitized live, or malformed. Never create a fixture only to match the parser you want to ship.

4. Readers fail closed. A missing or changed shape becomes unknown and never becomes zero.

5. A provider stays `UNVERIFIED` until the reviewed registry evidence says otherwise. A screenshot alone does not change that state.

## Interface work

1. Use `packages/ui/src/tokens.css` for color, spacing, radius, type, motion, and bar values. Do not introduce a component specific substitute.

2. Home shows only providers the user explicitly configured. Each provider shows every trustworthy window as one separate row.

3. Preserve dark and light themes, the 390 pixel layout, reduced motion behavior, and keyboard focus.

4. Keep `apps/web/app/app/language.ts` surgical. Run `pnpm test:i18n` after any catalog change.

## Pull request evidence

1. State the exact behavior changed and the failure it corrects.

2. List every command run with its result.

3. Include before and after captures for a visible change. Use synthetic fixtures unless the evidence is explicitly approved for public use.

4. State every remaining limitation. Do not call a local implementation deployed, a fixture live, or an unavailable feature complete.

5. Confirm that no test was weakened and no secret entered the diff or Git history.

## Developer Certificate of Origin

Every commit must include a DCO sign off line.

```text
Signed-off-by: Demo Contributor <demo@example.test>
```

This line certifies that you have the right to submit the contribution under the project license.

## Network and prose rules

Document every new egress host in [THREAT_MODEL.md](THREAT_MODEL.md) before adding network behavior.

Project prose does not use dash characters. Reword prose with commas, periods, parentheses, or colons. Technical identifiers, package names, paths, flags, and URLs keep their required spelling. Legal text remains verbatim.
