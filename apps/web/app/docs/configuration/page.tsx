import type { Metadata } from "next";
import { DocArticle } from "@/components/docs/doc-article";
import { Bullets, Callout, Code, CodeBlock, DocLink, P, Sub, Table } from "@/components/docs/prose";
import { docMetadata } from "@/lib/metadata";

export const metadata: Metadata = docMetadata("/docs/configuration");

export default function ConfigurationPage() {
  return (
    <DocArticle
      href="/docs/configuration"
      title="Configuration"
      lead="OpenLimiter keeps everything in one state directory under your own user account: a configuration file, a cache, a lock, and the optional manual document. This page says where that is and what each file does."
      sections={[
        {
          id: "state-directory",
          title: "The state directory",
          body: (
            <>
              <Table
                caption="Where the state directory lives on each platform"
                columns={[
                  { key: "platform", header: "platform" },
                  { key: "path", header: "path" },
                ]}
                rows={[
                  {
                    platform: "Windows",
                    path: <Code>%LOCALAPPDATA%\openlimiter</Code>,
                  },
                  {
                    platform: "macOS",
                    path: <Code>~/Library/Application Support/openlimiter</Code>,
                  },
                  {
                    platform: "Linux",
                    path: <Code>${"{XDG_STATE_HOME:-~/.local/state}"}/openlimiter</Code>,
                  },
                ]}
              />
              <P>
                The directory is created with restrictive permissions where the platform supports
                them. A path that turns out to be a symbolic link is rejected rather than followed.
              </P>
            </>
          ),
        },
        {
          id: "files",
          title: "What lives in it",
          body: (
            <Table
              caption="Files inside the state directory"
              columns={[
                { key: "file", header: "file" },
                { key: "role", header: "role" },
              ]}
              rows={[
                {
                  file: <Code>openlimiter-config.json</Code>,
                  role: (
                    <>
                      Written by <Code>openlimiter init</Code>. Records the connector list and
                      whether each one was detected.
                    </>
                  ),
                },
                {
                  file: <Code>openlimiter-cache.json</Code>,
                  role: "The one cache every command reads and every writer merges into.",
                },
                {
                  file: <Code>openlimiter.lock</Code>,
                  role: "Held by writers only. Readers never take it.",
                },
                {
                  file: <Code>manual.json</Code>,
                  role: (
                    <>
                      Optional. Quota you maintain by hand. See{" "}
                      <DocLink href="/docs/ingestion">ingestion</DocLink> for the shape.
                    </>
                  ),
                },
              ]}
            />
          ),
        },
        {
          id: "cache-behaviour",
          title: "How the cache behaves",
          body: (
            <>
              <Bullets
                items={[
                  <>
                    One schema, one file, one lock. There are no competing state files to reconcile.
                  </>,
                  <>
                    Readers never take the lock. A reader opens the file, validates that open
                    descriptor, and reads through it, so a path swapped after the check cannot
                    redirect the bytes.
                  </>,
                  <>
                    Writers take the lock, and the read, the merge, and the write all happen inside
                    it. A lock older than five seconds is treated as abandoned and reclaimed.
                  </>,
                  <>
                    Every replacement flushes to stable storage before the rename, so a reader
                    observes either the previous content or the new content and never a partial
                    file.
                  </>,
                ]}
              />
              <P>
                Cache health is visible at any time through <Code>openlimiter doctor</Code>, which
                prints the cache status and how many rows were dropped for failing validation.
              </P>
            </>
          ),
        },
        {
          id: "claude-code",
          title: "Claude Code settings",
          body: (
            <>
              <P>
                Use the absolute path to your clone. Forward slashes work on every platform,
                including Windows.
              </P>
              <CodeBlock
                label="settings.json"
                code={`{
  "statusLine": {
    "type": "command",
    "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js statusline"
  },
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /absolute/path/to/openlimiter/packages/cli/dist/bin.js hook"
          }
        ]
      }
    ]
  }
}`}
              />
              <Sub id="which-writes">Which of the two writes</Sub>
              <P>
                Only the statusline. It is the path that receives the session payload, so it is the
                path that updates the cache. The hook reads and never writes.
              </P>
            </>
          ),
        },
        {
          id: "credentials",
          title: "Credentials",
          body: (
            <>
              <Callout tone="key" title="Keys belong in the operating system credential store">
                The only credential OpenLimiter has any concept of is an OpenRouter key, and it
                belongs in your operating system credential store. It must never appear in
                repository files, cache files, exports, diagnostics, fixtures, or logs. Provider
                authentication artifacts are opened read only and are never rewritten, backed up,
                repaired, or migrated.
              </Callout>
              <P>
                The credential library call sits behind an interface, and the adapter is stubbed in
                this release, so <Code>openlimiter init</Code> cannot store a key until a driver is
                supplied. Nothing else on your machine is touched.
              </P>
            </>
          ),
        },
        {
          id: "detection",
          title: "Connector detection",
          body: (
            <>
              <P>
                Detection is a pure function of the environment the CLI hands a connector. Facts
                only the CLI can observe, such as a manual document sitting in the state directory,
                arrive as explicit markers, which is why <Code>openlimiter doctor</Code> never
                claims a connector is ready when it could not receive data.
              </P>
              <CodeBlock
                label="terminal"
                code={`openlimiter doctor
CONNECTOR DETECTED FRESHNESS DRIFT
claude no unknown UNVERIFIED
openrouter no unknown UNVERIFIED
codex no unknown UNVERIFIED
antigravity no unknown UNVERIFIED
opencode no unknown UNVERIFIED
manual yes fresh UNVERIFIED
CACHE ok DROPPED 0`}
              />
            </>
          ),
        },
      ]}
    />
  );
}
