import { createAuthenticatedWSS } from "@csbc-dev/auth0/server";
import { AppCore } from "../shared/appCore.js";

const port = Number(process.env.PORT ?? 3000);
const auth0Domain = process.env.AUTH0_DOMAIN;
const auth0ClientId = process.env.AUTH0_CLIENT_ID;
const auth0Audience = process.env.AUTH0_AUDIENCE;
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!auth0Domain || !auth0ClientId || !auth0Audience) {
  console.error("AUTH0_DOMAIN, AUTH0_CLIENT_ID, and AUTH0_AUDIENCE are required (see .env.example)");
  process.exit(1);
}

const wss = await createAuthenticatedWSS({
  port,
  auth0Domain,
  auth0Audience,
  allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : undefined,
  createCores: (user) => new AppCore(user),
  onTokenRefresh: (core, user) => core.updateUser(user),
  onEvent: (event) => {
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
  },
});

// HTTP /auth-config endpoint on the same port.
//
// `<auth0-gate>` configuration values (domain / client-id / audience /
// remote-url) are NOT secrets — they are designed to ship to clients as
// part of any Auth0 SPA. Keeping them in server-side env and serving
// them via a tiny GET endpoint means static / no-bundler clients can
// boot without baking tenant-specific values into HTML. See
// docs/patterns/server-config-discovery.md for the full rationale.
//
// `wss._server` is the underlying http.Server that `ws` creates when
// you pass `port`. It is a stable de facto entry point used widely in
// the ws ecosystem; we replace its default 426 response handler with
// one that also serves /auth-config and falls back to 426 otherwise.
const httpServer = wss._server;
httpServer.removeAllListeners("request");
httpServer.on("request", (req, res) => {
  // CORS — reuse the same allowlist we use for the WebSocket origin
  // check so a request that would have been allowed to upgrade is
  // also allowed to read the config.
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
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    // Cache briefly — config is server-controlled and rarely changes,
    // but a long max-age would slow recovery from a tenant rotation.
    res.setHeader("Cache-Control", "public, max-age=60");
    res.end(
      JSON.stringify({
        domain: auth0Domain,
        clientId: auth0ClientId,
        audience: auth0Audience,
        remoteUrl: `ws://localhost:${port}`,
      }),
    );
    return;
  }

  // ws's default response for non-upgrade requests.
  const body = "Upgrade Required";
  res.writeHead(426, {
    "Content-Type": "text/plain",
    "Content-Length": String(body.length),
  });
  res.end(body);
});

console.log(`@csbc-dev/auth0 example server listening on ws://localhost:${port}`);
console.log(`  config endpoint: http://localhost:${port}/auth-config`);
console.log(`  domain:    ${auth0Domain}`);
console.log(`  client-id: ${auth0ClientId}`);
console.log(`  audience:  ${auth0Audience}`);
console.log(`  origins:   ${allowedOrigins.length ? allowedOrigins.join(", ") : "(any)"}`);
