import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import {
  handleConnection,
  verifyAuth0Token,
  extractTokenFromProtocol,
} from "@csbc-dev/auth0/server";
import { AppCore } from "../shared/appCore.js";

// PORT validation. `Number(process.env.PORT ?? 3000)` is too lenient:
// `PORT=""` (a common "set but empty" shape in .env files) is NOT caught
// by `??` (only null/undefined are) and `Number("")` is 0, which silently
// binds an OS-chosen ephemeral port — a confusing failure to debug.
// (`PORT=abc` is the less dangerous case: it does NOT behave like 0 —
// Node's listen() runs the port through validatePort and rejects NaN with
// a thrown ERR_SOCKET_BAD_PORT, crashing loudly.) Validate explicitly and
// fail fast either way, matching the AUTH0_* precondition check below.
const rawPort = process.env.PORT?.trim() || "3000";
const port = Number.parseInt(rawPort, 10);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`Invalid PORT: "${rawPort}" (expected an integer 0–65535)`);
  process.exit(1);
}
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0ClientId = process.env.AUTH0_CLIENT_ID;
const auth0Audience = process.env.AUTH0_AUDIENCE;
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
// Explicit override for the URL advertised via /auth-config.
// When set, used verbatim. When unset, the endpoint derives the URL from
// the request's Host / X-Forwarded-Proto headers so the example works
// behind reverse proxies and on non-localhost hosts (see resolveRemoteUrl).
const publicWsUrl = process.env.PUBLIC_WS_URL?.trim() || "";

if (!auth0Domain || !auth0ClientId || !auth0Audience) {
  console.error("AUTH0_DOMAIN, AUTH0_CLIENT_ID, and AUTH0_AUDIENCE are required (see .env.example)");
  process.exit(1);
}

// Fail-open warning. The previous version of this example silently allowed
// any origin (WS + HTTP) when ALLOWED_ORIGINS was empty. Keep the
// permissive default so localhost dev with multiple Vite ports keeps
// working, but make the choice loud so it cannot be deployed unnoticed.
if (allowedOrigins.length === 0) {
  console.warn(
    "[server] ALLOWED_ORIGINS is empty — WebSocket and /auth-config will accept ANY origin.\n" +
    "         This is intended for local dev only. Set ALLOWED_ORIGINS in production.",
  );
}

const MAX_PAYLOAD = 256 * 1024;

// HTTP server first — owned by us, not by `ws`. The previous version
// reached into `wss._server` (a `ws` internal) and `removeAllListeners
// ("request")`'d every handler to splice in /auth-config; that broke
// silently on any future middleware or ws-side request listener.
// Owning the http.Server up front and attaching `ws` via `noServer: true`
// + manual `upgrade` keeps the dependency direction right: this example
// installs handlers on a server it created, instead of overwriting ones
// it didn't.
const httpServer = createServer((req, res) => {
  const origin = req.headers.origin;
  if (allowedOrigins.length === 0) {
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }

  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.statusCode = 204;
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/auth-config") {
    // Apply the SAME origin policy as the WebSocket upgrade below, so the
    // two surfaces share one rule instead of diverging. NOTE: this is for
    // behavioural symmetry, not secrecy — domain / clientId / audience are
    // not secrets (they ship to every browser via this very endpoint), and
    // a non-browser client (curl) can spoof the Origin header anyway, so
    // this 403 adds no real protection on its own. The CORS headers set
    // above are what actually stop a *browser* on a disallowed origin from
    // reading the response; this check just keeps the dev/prod behaviour
    // consistent with the WS path (any-origin in dev, allow-list in prod).
    if (allowedOrigins.length > 0 && (!origin || !allowedOrigins.includes(origin))) {
      res.statusCode = 403;
      res.end();
      return;
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=60");
    res.end(
      JSON.stringify({
        domain: auth0Domain,
        clientId: auth0ClientId,
        audience: auth0Audience,
        remoteUrl: resolveRemoteUrl(req),
      }),
    );
    return;
  }

  const body = "Upgrade Required";
  res.writeHead(426, {
    "Content-Type": "text/plain",
    "Content-Length": String(body.length),
  });
  res.end(body);
});

// `noServer: true` means ws does not attach an `upgrade` listener of its
// own. We run verifyClient-equivalent logic (origin + Auth0 token) ourselves
// against the http.Server's `upgrade` event, then call `wss.handleUpgrade`
// once the token has verified. Same security ordering as
// `createAuthenticatedWSS`: bad tokens are rejected with an HTTP error
// status BEFORE the 101 Switching Protocols response, so the client never
// sees an `open` event for an unauthorized token.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_PAYLOAD,
  handleProtocols(protocols) {
    for (const proto of protocols) {
      if (proto.startsWith("auth0-gate.bearer.")) return proto;
    }
    return false;
  },
});

httpServer.on("upgrade", (req, socket, head) => {
  // `verifyAuth0Token` does a JWKS network round-trip. During that gap
  // the client can drop the TCP connection, leaving us with a destroyed
  // socket by the time the verify resolves. Track abort signals up
  // front so the resume path can bail rather than calling
  // `wss.handleUpgrade` (or writing a 401 via `rejectUpgrade`) on a
  // dead socket. `createAuthenticatedWSS` is shielded from this because
  // ws's built-in `verifyClient` machinery handles the destroyed-socket
  // case internally; the noServer composition does not inherit that
  // shield, so we install it explicitly. Both listeners are `once`
  // because we only need the first-arriving signal — further events
  // on a destroyed socket are no-ops for our purposes.
  let aborted = false;
  const markAborted = () => { aborted = true; };
  socket.once("error", markAborted);
  socket.once("close", markAborted);

  const origin = req.headers.origin;
  if (allowedOrigins.length > 0) {
    if (!origin || !allowedOrigins.includes(origin)) {
      rejectUpgrade(socket, 403, "Forbidden origin");
      return;
    }
  }

  let token;
  try {
    token = extractTokenFromProtocol(req.headers["sec-websocket-protocol"]);
  } catch (err) {
    onAuthEvent({ type: "auth:failure", error: normalize(err) });
    rejectUpgrade(socket, 401, "Unauthorized");
    return;
  }

  verifyAuth0Token(token, {
    domain: auth0Domain,
    audience: auth0Audience,
  })
    .then((user) => {
      // Verify resolved, so the abort guards have done their job. Detach
      // them before the socket is handed to `ws` so the `markAborted`
      // closures don't ride along on a socket nobody reads `aborted` from
      // anymore. They're `once` (max one fire, auto-removed) so this is
      // about making the intent — "pre-verify-only state guards" — explicit
      // rather than fixing a leak.
      socket.off("error", markAborted);
      socket.off("close", markAborted);
      if (aborted || socket.destroyed) return;
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req, user);
      });
    })
    .catch((err) => {
      socket.off("error", markAborted);
      socket.off("close", markAborted);
      onAuthEvent({ type: "auth:failure", error: normalize(err) });
      // `rejectUpgrade` is itself destroyed-socket-safe (see helper),
      // but skipping here also avoids the spurious 401 log when the
      // client had already walked away mid-verify.
      if (aborted || socket.destroyed) return;
      rejectUpgrade(socket, 401, "Unauthorized");
    });
});

wss.on("connection", async (ws, req, preVerifiedUser) => {
  try {
    // `preVerifiedUser` carries the result of the pre-handshake JWKS
    // verification above; `handleConnection` honours it and skips a
    // second `verifyAuth0Token` call. We still pass `auth0Domain` /
    // `auth0Audience` because in-band `auth:refresh` (which arrives
    // AFTER `open` with a freshly-issued token the pre-handshake
    // verify cannot have seen) re-verifies using the same tenant
    // parameters. The "no double verify on the initial handshake"
    // guarantee is the documented contract of `handleConnection`'s
    // `preVerifiedUser` option (see @csbc-dev/auth0/server) — this
    // composition depends on it being honoured.
    await handleConnection(ws, req.headers["sec-websocket-protocol"], {
      auth0Domain,
      auth0Audience,
      createCores: (user) => new AppCore(user),
      onTokenRefresh: (core, user) => core.updateUser(user),
      onEvent: onAuthEvent,
      preVerifiedUser,
    });
  } catch (err) {
    // Reaching here is a failure DURING connection setup that
    // `onAuthEvent` does NOT already cover: `createCores`
    // (`new AppCore(user)`) throwing, or the RemoteShellProxy
    // construction failing. The pre-handshake auth failures are reported
    // by the upgrade handler above, and in-band `auth:refresh` failures
    // are handled inside `handleConnection` and surface through `onEvent`
    // — neither rejects this await. So an empty `catch {}` here would
    // close the socket with 1008 and erase exactly the class of fault an
    // operator most needs to see. Log it before closing.
    console.error("[ws] connection setup failed:", normalize(err));
    try { ws.close(1008, "Unauthorized"); } catch { /* socket may already be gone */ }
  }
});

httpServer.listen(port, () => {
  console.log(`@csbc-dev/auth0 example server listening on ws://localhost:${port}`);
  console.log(`  config endpoint: http://localhost:${port}/auth-config`);
  // domain / audience are enough to confirm the tenant + API the server
  // verifies against. The SPA client-id is not a secret (it ships to every
  // client via /auth-config), but the server never authenticates with it, so
  // it has little confirmation value here and is left out of the startup log.
  console.log(`  domain:    ${auth0Domain}`);
  console.log(`  audience:  ${auth0Audience}`);
  console.log(`  origins:   ${allowedOrigins.length ? allowedOrigins.join(", ") : "(any — dev only)"}`);
  console.log(`  remoteUrl: ${publicWsUrl || "(derived per request from Host / X-Forwarded-Proto)"}`);
});

// --- helpers ----------------------------------------------------------------

function onAuthEvent(event) {
  switch (event.type) {
    case "auth:success":
      console.log(`[ws] auth:success ${event.user?.email ?? event.user?.sub}`);
      break;
    case "auth:failure":
      console.warn(`[ws] auth:failure ${event.error?.message}`);
      break;
    case "auth:refresh":
      console.log(`[ws] auth:refresh ${event.user?.email ?? event.user?.sub}`);
      break;
    case "auth:refresh-failure":
      console.warn(`[ws] auth:refresh-failure ${event.error?.message}`);
      break;
    case "connection:close":
      console.log(`[ws] connection:close`);
      break;
  }
}

function normalize(err) {
  return err instanceof Error ? err : new Error(String(err));
}

// Resolve the WebSocket URL advertised through /auth-config.
//
//   1. `PUBLIC_WS_URL` env var (explicit override). Set this whenever the
//      server's externally reachable URL cannot be derived from request
//      headers — e.g. a deployment where the WS endpoint lives on a
//      different host than the config endpoint.
//   2. Otherwise, derive from the request:
//      - host    ← `Host` header
//      - scheme  ← `wss` when X-Forwarded-Proto === "https" OR the
//                  underlying socket is TLS-encrypted; else `ws`.
//
//   Falls back to `ws://localhost:${port}` only as a last resort when no
//   Host header was sent (shouldn't happen with HTTP/1.1+, but covers
//   the edge case).
function resolveRemoteUrl(req) {
  if (publicWsUrl) return publicWsUrl;
  const host = req.headers.host;
  if (!host) return `ws://localhost:${port}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] ?? "")
    .split(",")[0]
    .trim()
    .toLowerCase();
  const secure = forwardedProto === "https" || req.socket?.encrypted === true;
  return `${secure ? "wss" : "ws"}://${host}`;
}

// Spec-correct rejection for an HTTP upgrade request (`Connection:
// Upgrade`). Sending a plain `res.writeHead(...)` does not work — the
// socket has already been hijacked by the upgrade event — so we write
// the status line and headers directly onto the raw socket and destroy
// it. Matches what `WebSocketServer`'s default upgrade handler would
// have done.
//
// Destroyed-socket safe: when the client already closed the TCP
// connection (e.g. during the async window of `verifyAuth0Token`),
// writing to a destroyed socket throws `ERR_STREAM_DESTROYED` /
// emits an `error` event that we have no caller to forward to. The
// upfront `socket.destroyed` short-circuit makes the helper a no-op
// in that case so callers do not have to re-check before invoking.
function rejectUpgrade(socket, statusCode, statusText) {
  if (socket.destroyed) return;
  const reason = statusText || "Forbidden";
  socket.write(
    `HTTP/1.1 ${statusCode} ${reason}\r\n` +
    "Connection: close\r\n" +
    "Content-Length: 0\r\n" +
    "\r\n",
  );
  socket.destroy();
}
