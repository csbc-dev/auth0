// Unblessed example helper — NOT part of @csbc-dev/auth0's API surface.
//
// It bundles the concerns the package deliberately does NOT own (env
// loading + validation, CORS for arbitrary routes, a `/_shared/` static
// mount) and composes them with the package's server primitives:
//
//   - createAuthenticatedWSS({ server })  → attach the authenticated
//       WebSocket to an http.Server we own, alongside our HTTP routes.
//   - createAuthConfigHandler(...)        → serve the non-secret client
//       config at GET /auth-config (server-config-discovery pattern).
//   - heartbeatMs                         → opt-in WS ping/pong keepalive.
//
// This is the "ServerKit feeling", kept in example code so applications
// bring their own HTTP framework (Express / Fastify / raw http) and only
// reach for the three package primitives.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { createAuthenticatedWSS, createAuthConfigHandler } from "@csbc-dev/auth0/server";

const MIME_TYPES = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
};

/**
 * Read + validate env, build the HTTP server (CORS + /auth-config +
 * optional /_shared/ static mount), attach the authenticated WebSocket,
 * and start listening.
 *
 * @param {object} opts
 * @param {(user: import("@csbc-dev/auth0/server").UserContext) => EventTarget} opts.createCores
 * @param {(core: EventTarget, user: any) => void | Promise<void>} [opts.onTokenRefresh]
 * @param {string} [opts.sharedDir]   Absolute dir to expose under `/_shared/`.
 * @param {number} [opts.heartbeatMs] WS keepalive interval (default 30000; 0 disables).
 * @param {(event: import("@csbc-dev/auth0/server").AuthEvent) => void} [opts.onEvent]
 * @returns {Promise<{ httpServer: import("node:http").Server, wss: any, port: number }>}
 */
export async function createExampleServer({
  createCores,
  onTokenRefresh,
  sharedDir,
  heartbeatMs = 30_000,
  onEvent = defaultOnEvent,
}) {
  const { port, domain, clientId, audience, allowedOrigins, publicWsUrl } = readEnv();

  if (allowedOrigins.length === 0) {
    console.warn(
      "[server] ALLOWED_ORIGINS is empty — WebSocket and /auth-config will accept ANY origin.\n" +
        "         This is intended for local dev only. Set ALLOWED_ORIGINS in production.",
    );
  }

  // /auth-config owns its own CORS + 403 gate + the per-request remoteUrl
  // derivation (Host / X-Forwarded-Proto) unless PUBLIC_WS_URL pins it.
  const serveAuthConfig = createAuthConfigHandler({
    domain,
    clientId,
    audience,
    remoteUrl: publicWsUrl || undefined,
    allowedOrigins,
  });

  const httpServer = createServer((req, res) => {
    if (serveAuthConfig(req, res)) return; // handled /auth-config (+ its OPTIONS)

    // CORS for the remaining routes (the /_shared/ mount), mirroring the
    // WebSocket allowlist. Not origin-gated: the schema is non-secret, so
    // the body is served to anyone — the absent ACAO header is what stops
    // a *browser* on a disallowed origin from reading it cross-origin.
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

    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (sharedDir && req.method === "GET" && pathname.startsWith("/_shared/")) {
      serveShared(sharedDir, pathname, res);
      return;
    }

    const body = "Upgrade Required";
    res.writeHead(426, { "Content-Type": "text/plain", "Content-Length": String(body.length) });
    res.end(body);
  });

  // Attach the authenticated WebSocket to the server we own. `{ server }`
  // keeps the pre-handshake verifyClient token check (bad tokens never
  // get a 101) — the manual upgrade + rejectUpgrade dance is gone.
  const wss = await createAuthenticatedWSS({
    server: httpServer,
    auth0Domain: domain,
    auth0Audience: audience,
    allowedOrigins,
    createCores,
    onTokenRefresh,
    onEvent,
    heartbeatMs,
  });

  await new Promise((resolveListen) => httpServer.listen(port, resolveListen));

  console.log(`@csbc-dev/auth0 example server listening on ws://localhost:${port}`);
  console.log(`  config endpoint: http://localhost:${port}/auth-config`);
  console.log(`  domain:    ${domain}`);
  console.log(`  audience:  ${audience}`);
  console.log(`  origins:   ${allowedOrigins.length ? allowedOrigins.join(", ") : "(any — dev only)"}`);
  console.log(`  remoteUrl: ${publicWsUrl || "(derived per request from Host / X-Forwarded-Proto)"}`);

  return { httpServer, wss, port };
}

// --- helpers ----------------------------------------------------------------

function readEnv() {
  // PORT: `Number(process.env.PORT ?? 3000)` is too lenient — `PORT=""`
  // is not caught by `??` and `Number("")` is 0 (binds a random port).
  // Validate explicitly and fail fast.
  const rawPort = process.env.PORT?.trim() || "3000";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error(`Invalid PORT: "${rawPort}" (expected an integer 0–65535)`);
    process.exit(1);
  }

  const domain = process.env.AUTH0_DOMAIN;
  const clientId = process.env.AUTH0_CLIENT_ID;
  const audience = process.env.AUTH0_AUDIENCE;
  if (!domain || !clientId || !audience) {
    console.error("AUTH0_DOMAIN, AUTH0_CLIENT_ID, and AUTH0_AUDIENCE are required (see .env.example)");
    process.exit(1);
  }

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const publicWsUrl = process.env.PUBLIC_WS_URL?.trim() || "";

  return { port, domain, clientId, audience, allowedOrigins, publicWsUrl };
}

function defaultOnEvent(event) {
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

// Serve a file from `sharedDir` for a `/_shared/...` request. Self-contained:
// owns its own status codes (400 / 403 / 404) and never rejects back into the
// synchronous request handler. CORS headers were already set on `res`.
async function serveShared(sharedDir, pathname, res) {
  let relative;
  try {
    // decodeURIComponent throws URIError on a malformed escape (a bare `%`).
    relative = decodeURIComponent(pathname.slice("/_shared/".length));
  } catch {
    res.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bad Request");
    return;
  }

  // Resolve and confine to sharedDir — reject path traversal (`../`).
  const file = resolve(sharedDir, relative);
  const rootWithSep = sharedDir.endsWith(sep) ? sharedDir : sharedDir + sep;
  if (file !== sharedDir && !file.startsWith(rootWithSep)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(file);
    res.setHeader("Content-Type", MIME_TYPES[extname(file)] || "application/octet-stream");
    // Example glue; the schema is non-secret. Brief browser cache so a reload
    // doesn't re-fetch, while a facade edit still propagates within a minute.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.end(content);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not Found");
  }
}
