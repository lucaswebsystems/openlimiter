import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse
} from "node:http";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import {
  PROVIDER_CODES,
  buildAdvice,
  canonicalJson,
  floorFixed,
  readSnapshotCache,
  type Advice
} from "@openlimiter/core";
import { encodeQr, renderQr } from "./qr.js";

/**
 * The local quota server.
 *
 * This is the one place OpenLimiter opens a socket, and it is a listener, never
 * a client. It answers on your own network so a phone in your hand can read the
 * same numbers the statusline shows on the machine that is actually doing the
 * work. Nothing is uploaded, no account exists, and no provider is contacted.
 *
 * It is read only by construction. There is no route that writes, deletes, or
 * mutates anything, and the whole server never touches a credential store, a
 * provider authentication file, or a raw provider payload. The only thing it
 * can say is the bounded set of fields the agent context already carries:
 * provider codes, freshness states, a percentage, and a reset instant.
 *
 * Four gates stand between the socket and that payload:
 *
 *   1. A random token is generated on every start and is required on every
 *      route that carries data. It lives only in memory, is never written to
 *      disk, and is void the moment the command stops. The empty page shell at
 *      the root is the one route served without it, because the token travels
 *      in the URL fragment and a fragment never reaches a server. The shell
 *      holds no quota state, no token and no account detail: it is markup that
 *      then has to authenticate before anything is filled in.
 *   2. The Host header must be an address literal or localhost, which is what
 *      closes a DNS rebinding attack from a page on an attacker's domain.
 *   3. Cross origin requests are refused outright. The page this server hands
 *      out is same origin, so nothing legitimate needs a relaxation.
 *   4. Only GET and HEAD are answered. Every other method is refused before
 *      the token is even looked at.
 *
 * It is meant for a trusted home or office network. It is not exposed to the
 * internet, it opens no ports on a router, and it should not be reachable from
 * one. Anyone already on your network who also has the token can read your
 * quota state, which is the whole point and also the whole risk.
 */

/** Default listening port. Unassigned by IANA, and easy to type. */
export const DEFAULT_SERVE_PORT = 7317;

/** Default binding. Every interface, so a phone on the same network reaches it. */
export const DEFAULT_SERVE_HOST = "0.0.0.0";

/** Payload schema version. Bumped only on a breaking shape change. */
export const SERVE_SCHEMA = 1;

/**
 * Name the token travels under. Short, because it goes in a QR symbol.
 *
 * It is the key in the URL FRAGMENT of every address this command prints, and
 * for one more release it is also accepted as a query parameter so an address
 * saved from an older build keeps working.
 */
export const TOKEN_PARAMETER = "t";

/**
 * Why the token is in the fragment rather than the query.
 *
 * A query string is part of the request line. It lands in the phone's browser
 * history, in the omnibox suggestions, in whatever cloud that browser syncs
 * history to, and in the Referer of any link the page might carry. A fragment
 * is never sent to a server at all: it stays in the address bar until the page
 * itself reads it, and the page's first act is to move it into sessionStorage
 * and rewrite the address to a clean one. From that point the token exists only
 * in the tab's own memory and is sent as an Authorization header, so no URL
 * anywhere on the phone carries the capability.
 *
 * docs/SYNC_ARCHITECTURE.md already required exactly this of pairing links.
 */
export const TOKEN_FRAGMENT_PREFIX = "#" + TOKEN_PARAMETER + "=";

/** Key the page keeps the token under, inside its own tab and nowhere else. */
const TOKEN_STORAGE_KEY = "openlimiter.token";

/** Longest request target this server will look at. */
const MAX_TARGET_LENGTH = 512;

/** Bounds on the socket, so a stalled client cannot hold a slot forever. */
const HEADERS_TIMEOUT_MILLISECONDS = 5_000;
const REQUEST_TIMEOUT_MILLISECONDS = 10_000;
const KEEP_ALIVE_TIMEOUT_MILLISECONDS = 5_000;
const MAX_CONNECTIONS = 32;

/** Bytes of entropy in the token. */
const TOKEN_BYTES = 16;

/**
 * One provider line, carrying exactly the fields the agent context carries.
 *
 * Nothing else from the snapshot is exposed. No source, no labels, no meter
 * name, and above all nothing that came out of a provider as text.
 */
export interface ServedProvider {
  provider: string;
  state: "fresh" | "stale";
  usagePercent: number;
  resetAt: string | null;
}

export interface QuotaDocument {
  schema: typeof SERVE_SCHEMA;
  generatedAt: string;
  reason: Advice["reason"];
  providers: readonly ServedProvider[];
  unknown: readonly string[];
}

export interface QuotaServerOptions {
  host?: string;
  /** Port to listen on. Zero asks the operating system for a free one. */
  port?: number;
  /** Token to require. One is generated when this is left out. */
  token?: string;
  stateDirectory?: string | undefined;
  now?: () => string;
}

export interface QuotaServerHandle {
  readonly host: string;
  readonly port: number;
  readonly token: string;
  /** The address to open on another device, token included. */
  readonly url: string;
  /** The address on this machine, token included. */
  readonly localUrl: string;
  close(): Promise<void>;
}

/**
 * The address another device on the same network should open.
 *
 * A bound address of every interface tells a phone nothing, so the first non
 * internal IPv4 address is what gets printed. IPv6 is skipped deliberately: a
 * link local address needs a zone identifier that does not survive a QR symbol.
 */
export function lanAddress(): string | null {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function authority(host: string, port: number): string {
  const wrapped = isIP(host) === 6 ? "[" + host + "]" : host;
  return wrapped + ":" + String(port);
}

/**
 * Decide whether the Host header may be served.
 *
 * A DNS rebinding attack works by pointing a name the attacker controls at an
 * address on your network and letting a page on that name talk to a server
 * there. The name always arrives in the Host header, so refusing every name
 * except localhost closes it. Address literals are accepted because they
 * cannot be rebound.
 */
export function isAllowedHostHeader(
  header: string | undefined,
  boundPort: number
): boolean {
  if (header === undefined || header === "") return false;
  let parsed: URL;
  try {
    parsed = new URL("http://" + header);
  } catch {
    return false;
  }
  if (parsed.pathname !== "/" || parsed.search !== "" || parsed.username !== "") {
    return false;
  }
  const port = parsed.port === "" ? 80 : Number(parsed.port);
  if (port !== boundPort) return false;
  const hostname = parsed.hostname;
  if (hostname === "localhost") return true;
  /* A bracketed IPv6 literal loses its brackets through the URL parser. */
  const literal = hostname.startsWith("[") ? hostname.slice(1, -1) : hostname;
  return isIP(literal) !== 0;
}

/**
 * Read the token a request presents.
 *
 * The header is the supported way and is read first. The query parameter is a
 * fallback kept for one release so an address copied out of an older build
 * still answers; nothing this command prints uses it any more.
 */
export function presentedToken(
  authorization: string | undefined,
  target: URL
): string | null {
  if (typeof authorization === "string") {
    const space = authorization.indexOf(" ");
    if (space > 0 && authorization.slice(0, space).toLowerCase() === "bearer") {
      const value = authorization.slice(space + 1).trim();
      if (value !== "") return value;
    }
    return null;
  }
  return target.searchParams.get(TOKEN_PARAMETER);
}

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) {
    /* Compare against itself so the work done does not leak the length. */
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Build the document served on the quota route.
 *
 * The advice engine in the core does the work, exactly as it does for the
 * statusline and the hook, so a phone can never see a number the agent would
 * not have seen. A cache that cannot be read becomes an empty document with
 * every provider unknown, never a zero and never a cap.
 */
export async function quotaDocument(
  stateDirectory: string | undefined,
  now: string
): Promise<QuotaDocument> {
  const cached = await readSnapshotCache(stateDirectory);
  const advice = buildAdvice(
    cached.ok ? cached.snapshots : [],
    now,
    PROVIDER_CODES
  );
  return {
    schema: SERVE_SCHEMA,
    generatedAt: now,
    reason: advice.reason,
    providers: advice.providers.map((entry) => ({
      provider: entry.provider,
      state: entry.state,
      usagePercent: Number(floorFixed(entry.usagePercent, 2)),
      resetAt: entry.resetAt
    })),
    unknown: [...advice.unknownProviders]
  };
}

type ResponseHeaders = Record<string, string>;

function securityHeaders(): ResponseHeaders {
  return {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    /* No Access-Control-Allow-Origin is ever sent. The page is same origin. */
    vary: "Origin"
  };
}

function sendJson(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  body: unknown
): void {
  const text = canonicalJson(body);
  response.writeHead(status, {
    ...securityHeaders(),
    "content-security-policy": "default-src 'none'",
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(text, "utf8"))
  });
  /* A HEAD response carries the headers of the GET and none of its body. */
  response.end(request.method === "HEAD" ? undefined : text);
}

function sendHtml(
  request: IncomingMessage,
  response: ServerResponse,
  status: number,
  html: string
): void {
  response.writeHead(status, {
    ...securityHeaders(),
    "content-security-policy": [
      "default-src 'none'",
      "style-src 'unsafe-inline'",
      "script-src 'unsafe-inline'",
      "connect-src 'self'",
      "base-uri 'none'",
      "form-action 'none'"
    ].join("; "),
    "content-type": "text/html; charset=utf-8",
    "content-length": String(Buffer.byteLength(html, "utf8"))
  });
  response.end(request.method === "HEAD" ? undefined : html);
}

/**
 * The mobile page.
 *
 * One file, no build step, no external request of any kind. It reads the same
 * JSON route a script would, on the same origin, carrying the same token that
 * is already in the address bar. The colours mirror the design tokens on the
 * site, and the whole thing follows the reader's own light or dark setting.
 */
export function mobilePage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>OpenLimiter quota</title>
<style>
:root{color-scheme:light dark;--canvas:#fff;--surface:#f6f6f7;--track:#e2e2e6;--hairline:#e5e5e8;--heading:#0d0d0f;--body:#53535c;--muted:#62626c;--accent:#0866ff;--warn:#b45309;--stop:#b42318}
@media (prefers-color-scheme:dark){:root{--canvas:#0a0a0b;--surface:#121214;--track:#26262b;--hairline:#232327;--heading:#f2f2f3;--body:#adadb6;--muted:#94949e;--accent:#6ba6ff;--warn:#f0b429;--stop:#ff6b6b}}
*{box-sizing:border-box}
body{margin:0;padding:20px 16px 48px;background:var(--canvas);color:var(--body);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:520px;margin:0 auto}
h1{margin:0 0 2px;font-size:19px;font-weight:600;letter-spacing:-.01em;color:var(--heading)}
.sub{margin:0 0 20px;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.state{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--hairline);border-radius:8px;padding:5px 10px;font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);background:var(--surface)}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}
.card{border:1px solid var(--hairline);border-radius:14px;background:var(--surface);padding:14px 16px;margin-top:10px}
.row{display:flex;align-items:baseline;justify-content:space-between;gap:12px}
.name{font-size:14px;font-weight:600;color:var(--heading);letter-spacing:.01em}
.pct{font:600 20px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--heading);font-variant-numeric:tabular-nums}
.bar{margin-top:10px;height:6px;border-radius:999px;background:var(--track);overflow:hidden}
.fill{height:100%;border-radius:999px;background:var(--accent);transition:width .3s ease}
.fill.near{background:var(--warn)}
.fill.at{background:var(--stop)}
.meta{margin-top:8px;display:flex;gap:10px;flex-wrap:wrap;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--muted)}
.note{margin-top:22px;font-size:12px;line-height:1.6;color:var(--muted)}
.err{color:var(--stop)}
</style>
</head>
<body>
<main>
  <h1>OpenLimiter</h1>
  <p class="sub" id="stamp">Loading quota from this machine.</p>
  <p><span class="state"><span class="dot" id="dot"></span><span id="reason">reading</span></span></p>
  <div id="cards"></div>
  <p class="note" id="unknown"></p>
  <p class="note">
    Served from the machine running OpenLimiter, over your own network. Nothing here
    left that machine, nothing was uploaded, and this page can only read.
  </p>
</main>
<script>
(function(){
  /* The token arrives in the fragment, which no server ever sees. Move it into
     this tab's own memory and wipe the address, so the history entry the phone
     keeps, and syncs, carries no capability.

     The query is read as well, and first, because an address printed by an
     older build put the token there. Such an address still reaches this page,
     and a page that only looked at the fragment would sit at 401 forever with
     the token visible in the address bar the whole time. Reading it, then
     scrubbing BOTH the query and the fragment in one replaceState, turns the
     old address into the new behaviour on its first load. */
  var key = ${JSON.stringify(TOKEN_STORAGE_KEY)};
  var name = ${JSON.stringify(TOKEN_PARAMETER)};
  var prefix = ${JSON.stringify(TOKEN_FRAGMENT_PREFIX)};
  var token = "";
  var fromAddress = false;
  try {
    var queried = new URLSearchParams(location.search).get(name);
    if (queried) {
      token = queried;
      fromAddress = true;
    } else if (location.hash.indexOf(prefix) === 0) {
      token = decodeURIComponent(location.hash.slice(prefix.length));
      fromAddress = true;
    }
  } catch (error) {
    token = "";
  }
  if (fromAddress) {
    try { sessionStorage.setItem(key, token); } catch (error) {}
    /* One rewrite, dropping the query and the fragment together. */
    try { history.replaceState(null, "", location.pathname); } catch (error) {}
  } else {
    try { token = sessionStorage.getItem(key) || ""; } catch (error) { token = ""; }
  }
  var cards = document.getElementById("cards");
  var stamp = document.getElementById("stamp");
  var reason = document.getElementById("reason");
  var dot = document.getElementById("dot");
  var unknown = document.getElementById("unknown");
  function tone(value){ return value >= 100 ? "at" : value >= 80 ? "near" : ""; }
  function clock(value){
    if (value === null) return "no reset";
    var when = new Date(value);
    return isNaN(when.getTime()) ? "no reset" : "resets " + when.toLocaleString();
  }
  function draw(document_){
    reason.textContent = document_.reason.toLowerCase().replace("_"," ");
    dot.style.background = document_.reason === "AT_CAP" ? "var(--stop)"
      : document_.reason === "NEAR_CAP" ? "var(--warn)" : "var(--accent)";
    stamp.textContent = "Updated " + new Date(document_.generatedAt).toLocaleTimeString();
    stamp.className = "sub";
    cards.textContent = "";
    document_.providers.forEach(function(entry){
      var card = document.createElement("div");
      card.className = "card";
      var row = document.createElement("div");
      row.className = "row";
      var name = document.createElement("span");
      name.className = "name";
      name.textContent = entry.provider;
      var pct = document.createElement("span");
      pct.className = "pct";
      pct.textContent = entry.usagePercent.toFixed(1) + "%";
      row.appendChild(name); row.appendChild(pct);
      var bar = document.createElement("div");
      bar.className = "bar";
      var fill = document.createElement("div");
      fill.className = "fill " + tone(entry.usagePercent);
      fill.style.width = Math.min(100, Math.max(0, entry.usagePercent)) + "%";
      bar.appendChild(fill);
      var meta = document.createElement("div");
      meta.className = "meta";
      var state = document.createElement("span");
      state.textContent = entry.state;
      var reset = document.createElement("span");
      reset.textContent = clock(entry.resetAt);
      meta.appendChild(state); meta.appendChild(reset);
      card.appendChild(row); card.appendChild(bar); card.appendChild(meta);
      cards.appendChild(card);
    });
    unknown.textContent = document_.unknown.length === 0
      ? ""
      : "Unknown, so nothing is claimed for them: " + document_.unknown.join(", ") + ".";
  }
  function load(){
    /* The token goes in a header, never in a URL, so nothing that repeats every
       fifteen seconds can write it into a log or a history entry. */
    fetch("/quota.json", {
      cache: "no-store",
      headers: { "authorization": "Bearer " + token }
    })
      .then(function(response){
        if (!response.ok) throw new Error(String(response.status));
        return response.json();
      })
      .then(draw)
      .catch(function(error){
        stamp.className = "sub err";
        stamp.textContent = error.message === "401"
          ? "The token in this address is not valid. Scan the code again."
          : "Cannot reach the machine running OpenLimiter.";
      });
  }
  load();
  setInterval(load, 15000);
})();
</script>
</body>
</html>
`;
}

/**
 * Start the local quota server.
 *
 * The returned handle carries the port that was actually bound, which matters
 * when port zero was asked for, and closes every connection on shutdown so a
 * caller is never left waiting on a keep alive socket.
 */
export async function startQuotaServer(
  options: QuotaServerOptions = {}
): Promise<QuotaServerHandle> {
  const host = options.host ?? DEFAULT_SERVE_HOST;
  const port = options.port ?? DEFAULT_SERVE_PORT;
  const token = options.token ?? randomBytes(TOKEN_BYTES).toString("base64url");
  const clock = options.now ?? (() => new Date().toISOString());
  const stateDirectory = options.stateDirectory;

  /* Rewritten once the socket is bound, which is what port zero needs. */
  let listeningPort = port;

  async function handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    const method = request.method ?? "GET";
    if (method !== "GET" && method !== "HEAD") {
      response.writeHead(405, { ...securityHeaders(), allow: "GET, HEAD" });
      response.end();
      return;
    }
    const rawTarget = request.url ?? "/";
    if (rawTarget.length > MAX_TARGET_LENGTH) {
      sendJson(request, response, 414, { error: "target_too_long" });
      return;
    }
    if (!isAllowedHostHeader(request.headers.host, listeningPort)) {
      sendJson(request, response, 403, { error: "host_not_allowed" });
      return;
    }
    /* No cross origin caller is ever wanted, so any origin at all is refused. */
    if (typeof request.headers.origin === "string") {
      sendJson(request, response, 403, { error: "cross_origin_refused" });
      return;
    }
    let target: URL;
    try {
      target = new URL(rawTarget, "http://localhost");
    } catch {
      sendJson(request, response, 400, { error: "bad_request" });
      return;
    }
    /*
     * The shell is served before the token is looked at, and only the shell.
     * It has to be, because the token is in the fragment and the fragment never
     * arrives here. It carries no reading, no token and no account detail, so
     * anyone who fetches it learns only that this command is running, which the
     * open port already told them.
     */
    if (target.pathname === "/") {
      sendHtml(request, response, 200, mobilePage());
      return;
    }
    const presented = presentedToken(request.headers.authorization, target);
    if (presented === null || !constantTimeEquals(presented, token)) {
      sendJson(request, response, 401, { error: "token_required" });
      return;
    }
    if (target.pathname === "/quota.json") {
      sendJson(request, response, 200, await quotaDocument(stateDirectory, clock()));
      return;
    }
    sendJson(request, response, 404, { error: "not_found" });
  }

  const server: Server = createServer((request, response) => {
    /* Nothing here consumes a body. Draining keeps the socket reusable. */
    request.resume();
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        sendJson(request, response, 500, { error: "internal" });
        return;
      }
      response.end();
    });
  });

  server.headersTimeout = HEADERS_TIMEOUT_MILLISECONDS;
  server.requestTimeout = REQUEST_TIMEOUT_MILLISECONDS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MILLISECONDS;
  server.maxConnections = MAX_CONNECTIONS;

  await new Promise<void>((resolve, reject) => {
    const onError = (error: unknown): void => {
      server.off("listening", onListening);
      reject(error instanceof Error ? error : new Error("listen failed"));
    };
    const onListening = (): void => {
      server.off("error", onError);
      const address = server.address();
      if (address !== null && typeof address === "object") {
        listeningPort = address.port;
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });

  /* Fragment, not query. See TOKEN_FRAGMENT_PREFIX above for why. */
  const suffix = "/" + TOKEN_FRAGMENT_PREFIX + token;
  const advertised = host === "0.0.0.0" || host === "::"
    ? lanAddress() ?? "127.0.0.1"
    : host;

  return {
    host,
    port: listeningPort,
    token,
    url: "http://" + authority(advertised, listeningPort) + suffix,
    localUrl: "http://" + authority("127.0.0.1", listeningPort) + suffix,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    }
  };
}

export interface ServeBannerOptions {
  /** Paint the QR symbol, which a dark themed terminal needs. */
  color?: boolean;
  /** Leave the QR symbol out entirely. */
  withoutQr?: boolean;
}

/**
 * The text printed when the server starts.
 *
 * The address is printed before the symbol and again after it, because a
 * terminal that cannot draw the symbol still has to be usable, and because the
 * address is the thing a person types when a camera will not focus.
 */
export function serveBanner(
  handle: QuotaServerHandle,
  options: ServeBannerOptions = {}
): string {
  const lines = [
    "OpenLimiter is serving read only quota on your local network.",
    "",
    "  " + handle.url,
    ""
  ];
  if (options.withoutQr !== true) {
    try {
      lines.push(
        renderQr(encodeQr(handle.url), { color: options.color ?? false }),
        ""
      );
    } catch {
      lines.push("The address is too long to draw as a scannable code.", "");
    }
  }
  lines.push(
    "On this machine: " + handle.localUrl,
    "",
    "Scan the code with a phone on the same network, or type the address.",
    "The token changes every time this command starts, and nothing answers without it.",
    "The code and the address ARE the key: anyone who can see this screen, or a",
    "photograph of it, can read your quota for as long as this command runs.",
    "Read only: no route here can change anything on this machine, and no",
    "credential, provider payload, or account detail is ever served.",
    "Meant for a trusted home or office network. This listens on every interface",
    "on this machine, so do not port forward this port and do not open it on a",
    "firewall: nothing but your router's default is keeping it off the internet.",
    "",
    "Press Ctrl C to stop."
  );
  return lines.join("\n");
}
