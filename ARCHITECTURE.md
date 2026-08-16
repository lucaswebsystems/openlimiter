# Architecture

## Layered design

The core owns the snapshot contract, normalization, cache, freshness, forecast, and advice policy. It contains no provider parsing.

Connectors translate a known response shape into raw meters. They perform no network access and never write provider authentication artifacts.

Adapters translate bounded advice into an agent specific representation. The Claude Code hook reads the cache only.

The CLI coordinates detection, cache reads, ingestion, diagnostics, demos, and exports. Three ingestion paths feed the cache and none of them reaches the network: a Claude Code statusline payload arriving on standard input, a manual document in the state directory, and the generic ingest command.

## Snapshot schema

A snapshot contains provider, meter, value, unit, window, resetAt, source, precision, observedAt, expiresAt, and connector labels.

The labels are credentialOrigin, dataInterfaceStatus, automationRisk, and verification.

Provider codes, units, sources, precision values, and label values are closed enums. Meter names use a bounded uppercase identifier. Percentage values remain between zero and one hundred.

Freshness is derived from observedAt, expiresAt, and an injected current time. Pure policy code never reads the system clock.

Displayed percentages are truncated rather than rounded, so no surface can report a cap that was not reached.

## Connector contract

A connector exposes id, displayName, labels, detect, and read. Detection is pure and uses only the supplied environment map. Facts that only the CLI can observe, such as the presence of a manual document, reach detection as explicit environment markers set by the CLI.

Read accepts a caller supplied context and returns either meters or a closed failure reason.

Every connector is read only. Missing or unrecognized input returns unknown. A single unusable row is dropped and the remaining rows still count, because one bad window is not a reason to forget a whole provider.

## Desktop connection layer

For providers whose credentials it holds, the desktop application owns the complete collection transaction in Rust: allowlisted request, bounded parse, cache fold, attempt completion, and durable scheduling. Native readers mirror the closed contracts in packages/connectors; the package parsers remain unchanged for CLI and browser ingestion. Provider response bodies never cross IPC. A secret crosses from the webview into Rust exactly once, on connection, and from that moment it lives in the operating system's own credential store, Windows Credential Manager, macOS Keychain, or the Linux Secret Service, under an opaque connection id. No command reads a stored secret back to the webview; only a masked label ever returns.

Every request Rust can make is closed by construction. One enum names every reachable address, each carrying a single constant endpoint that belongs to one provider, and nothing arriving over IPC, from a provider response, or from configuration can widen or redirect it. Redirects are refused outright, so an allowlisted address can never forward a request, or the credential attached to it, anywhere else.

Each reader carries its own trusted collection cadence rather than one shared timer: three hundred seconds for OpenRouter and Codex, six hundred for Antigravity, and an explicit exemption for OpenCode, whose browser held session is read only when a person asks. The next attempt is persisted on the native connection record, failures back off from the reader's own floor, and a wake from sleep recomputes what is due. Claude Code carries no reader or cadence at all, because its numbers already arrive on their own once the statusline is wired.

A desktop observation still lands in the one cache the CLI owns. Rust takes the cache's existing cross process lock, validates existing rows and suppressions, folds the native collection report with the same provider, meter, and account identity, and replaces the document atomically. The webview only rereads that state. One schema and one cache remain shared across every surface.

## One binary, one schema, one cache

One binary gives agent tools and people the same commands.

One schema prevents provider text from crossing into policy or agent context.

One cache avoids competing state files and keeps the hook path fast. The cache uses one state directory, one file name, one lock name, atomic replacement, strict validation, symbolic link rejection, and restrictive permissions where supported.

## Concurrency and durability

Readers never take the lock. A reader opens the cache file, validates that open descriptor, and reads through it, so a path swapped after the check cannot redirect the bytes. Because every write lands through an atomic rename, a lock free reader still observes either the previous content or the new content and never a partial file.

Writers take one lock file in the state directory. The lock carries the owner process id and a timestamp. A lock older than five seconds is treated as abandoned and reclaimed, and a writer that finds a live lock retries with a bounded backoff instead of failing. A writer only removes a lock that still carries its own stamp.

The read, the merge, and the write of a cache update all happen inside that one lock, so two writers observing different providers cannot silently drop each other's rows.

Every file replacement flushes the payload to stable storage before the rename and retries the transient replacement failures that Windows reports while another process briefly holds the destination open. The configuration file is written the same way. It does not take the cache lock, because it is a different file with a single writer.

## Failure posture

The hook and statusline paths are invoked by another tool, so they exit zero whatever happens and report unknown instead of breaking their host. Every other command returns a distinct exit code: zero for success, one for a genuine failure, two for a usage error, and three when no bounded quota data exists. Messages on standard error are drawn from a fixed set of strings and never carry provider text, paths from a payload, or secrets.
