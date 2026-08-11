# Threat model

## Protected assets

Protected assets include provider credentials, browser sessions, quota state, local configuration, and agent context integrity.

## Agent context injection boundary

Provider text is untrusted data. Connector parsers select known numeric fields and known timestamps. They discard labels, messages, account text, markup, and unknown fields.

The advice engine emits only provider enum codes, reason enum codes, bounded percentages, freshness enum codes, and timestamps. The Claude Code adapter validates these values again and wraps them in an explicit untrusted data boundary.

If every provider is unknown, the adapter injects nothing.

## Secret handling

Provider authentication artifacts are read only. OpenLimiter never rewrites, backs up, repairs, or migrates them.

OpenRouter credentials belong only in the operating system credential store. Repository files, cache files, exports, diagnostics, fixtures, and logs must never contain the key.

The credential library call is behind an interface. Tests use only a memory implementation with a synthetic key.

## Connector drift

Unofficial interfaces may change without notice. Every connector is marked UNVERIFIED. Parsing fails closed to unknown on missing fields, new shapes, unsafe numbers, expired windows, or invalid timestamps.

Doctor output reports drift as UNVERIFIED until an explicit verifier exists. It remains redacted.

A well formed response whose meaning has changed is the dangerous case, because it arrives with a success status. When a connector refuses a body the affected provider and account are suppressed in the snapshot cache itself, so every reader on the machine reports that provider unknown in the same instant rather than one surface showing a stale number. A suppression list that cannot be read makes the whole document unknown rather than being partially salvaged.

## Egress allowlist

The desktop application performs provider egress. Nothing else in the project does: the command line tool and the web application still read only local state.

Every address the desktop process can reach is a compile time constant in `apps/desktop/src-tauri/src/net.rs`, reachable only through the closed `ProviderEndpoint` enum. There is no command that fetches a URL, and no URL, host, header, or method crosses IPC, appears in a provider specification, or is read out of a provider response. The transport speaks HTTPS only, refuses redirects, applies a fifteen second total budget, and bounds a response at one mebibyte. A body outside the 200 range is dropped unread.

Which address a stored secret may be sent to is decided by `reader_route`, exhaustively, from the connection's own provider and credential kind. All twenty provider and credential pairings are decided in code; the fifteen wrong ones are refused. A secret is never handed to an address that belongs to another provider.

One reader takes two requests. OpenCode publishes no usage interface, so its meters are read from a logged in workspace page whose path is per account. Both addresses are still constants; the workspace handle between them is parsed out of a redirect target, validated against the provider's own opaque token shape, and joined between two constants. The redirect is never followed.

No connector may send cache content, other provider state, prompts, source code, or diagnostics.

## Completion integrity

`CONNECTED`, and the success timestamp beside it, are claims that a provider was really read. Parsing lives in TypeScript by design, so the webview is what decides whether a body was understood, and a compromised webview must not be able to turn that into a claim about a read that never happened.

Rust therefore witnesses the read. It increments an attempt generation before each request, and records that generation as delivered only when this process watched that exact request return a status in the 200 range carrying a non empty body which was then handed to the webview. A completion is refused unless it presents the current generation AND that generation is the witnessed one. Every disposition needs the witness, including `drift` and `cache_failure`, because both are claims about a body. The witness is cleared when an attempt delivers nothing, and spent when it is used, so one real read cannot be replayed. Completions are additionally rate limited.

Accepted residual risk. A compromised webview can still misreport what it did with a body it genuinely received: it can call a body parsed that it never parsed, or call a real reading drift. The bound on that is real but partial. It cannot fabricate a reading, because the snapshot rows it writes go through the shared normalizer and the cache write handshake. It cannot claim a success without a provider response, because the witness requires one. What it can do is lie about the meaning of a response that did arrive.

This is accepted rather than fixed, for a stated reason: closing it means moving provider specific parsing into Rust, which would put a second implementation of every meter shape beside the one the command line tool and the web application already share, and divergence between two parsers is a larger and quieter honesty risk than the one it would remove. A webview compromise is also already a compromise of the surface that displays every number, so the attacker who could forge a parse could equally forge the rendering.

## Telemetry

OpenLimiter has no telemetry. It does not send usage, diagnostics, identifiers, prompts, or quota state to the project authors.
