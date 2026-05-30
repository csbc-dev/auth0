# Pattern: server-config-discovery

A documented pattern for **remote-mode** deployments where the static client should not bake `domain` / `client-id` / `audience` / `remote-url` into HTML — typically because the same HTML is shipped to multiple environments (dev/staging/prod) or hosted off a CDN.

The server (`createAuthenticatedWSS`) already holds the same tenant values it needs to verify tokens. This pattern lets the static client fetch those values at boot from a small **`GET /auth-config`** endpoint mounted on the same port as the WebSocket, then stamp them onto `<auth0-gate>`.

> Status: **built-in as composable primitives.** `@csbc-dev/auth0/server`
> ships `createAuthConfigHandler(...)` — a framework-agnostic
> request-handler factory that serves the config JSON (CORS,
> cache-control, per-request `remoteUrl` derivation, and an `extend()`
> hook for extra fields). The browser package ships `<auth0-config>`,
> which fetches that JSON and exposes `domain` / `clientId` / `audience` /
> `remoteUrl` / `loading` / `error` as wc-bindable state. You still own
> the HTTP layer and the declarative wiring into `<auth0-gate>`.

## Why this is OK security-wise

`<auth0-gate>` accepts four configuration values:

| Value | Secret? | Why |
|---|---|---|
| `domain` | no | Public Auth0 tenant identifier |
| `client-id` | no | SPA applications have no client secret by design |
| `audience` | no | Just the API Identifier string — not a credential |
| `remote-url` | no | Public WebSocket endpoint |

A `GET /auth-config` endpoint is therefore a **delivery convenience**, not a security boundary. CORS gates **who** can read it (so a phishing site on another origin can't extract the values directly), but the values themselves are designed to ship to clients in any Auth0 SPA flow.

## Sequence

```
┌────────────┐                       ┌─────────────────────────┐
│  static    │                       │  example/server/server.js│
│  index.html│                       │  (createAuthenticatedWSS)│
└─────┬──────┘                       └─────────────┬───────────┘
      │                                            │
      │ 1. GET /auth-config (HTTP, same port as ws)│
      ├───────────────────────────────────────────►│
      │                                            │
      │ 2. 200 { domain, clientId, audience,       │
      │         remoteUrl }                        │
      │◄───────────────────────────────────────────┤
      │                                            │
      │ 3. <auth0-config> publishes bindable state │
      │                                            │
      │ 4. bindings stamp attrs on <auth0-gate>    │
      │                                            │
      │ 5. <auth0-gate> opens WebSocket            │
      ├───────────────────────────────────────────►│  (normal handshake
      │                                            │   per SPEC-REMOTE.md)
```

## Server side

You own the `http.Server`; mount `createAuthConfigHandler()` as one route on it and attach the authenticated WebSocket with `createAuthenticatedWSS({ server })`. The factory's `{ server }` mode keeps the pre-handshake `verifyClient` token check (bad tokens never get a `101`), so no hand-written `upgrade` / `rejectUpgrade` plumbing is needed.

```js
// Composable form — full control over your HTTP layer.
import { createServer } from "node:http";
import {
  createAuthenticatedWSS,
  createAuthConfigHandler,
} from "@csbc-dev/auth0/server";

// Owns its own CORS, 403 gate, Cache-Control, and per-request remoteUrl
// derivation. Returns true once it has handled the request.
const serveAuthConfig = createAuthConfigHandler({
  domain: auth0Domain,
  clientId: auth0ClientId,
  audience: auth0Audience,
  allowedOrigins,                 // mirror the WS allowlist
  remoteUrl: process.env.PUBLIC_WS_URL || undefined, // else derive from Host
  // extend: (req) => ({ featureFlags, ... }),        // optional extra fields
});

const httpServer = createServer((req, res) => {
  if (serveAuthConfig(req, res)) return;  // GET /auth-config + its OPTIONS
  // …your own routes (/_shared/, /healthz)…
  res.writeHead(426, { "Content-Type": "text/plain" });
  res.end("Upgrade Required");
});

const wss = await createAuthenticatedWSS({
  server: httpServer,             // ← attach, don't own the port
  auth0Domain,
  auth0Audience,
  allowedOrigins,
  createCores: (user) => new AppCore(user),
  onTokenRefresh: (core, user) => core.updateUser(user),
  heartbeatMs: 30_000,            // opt-in WS keepalive
});

httpServer.listen(port);
```

For the pure standalone case (no other HTTP routes), skip the manual `http.Server` entirely with the `exposeAuthConfig` sugar — the factory creates and owns the server, mounts `/auth-config`, and 426s everything else:

```js
const wss = await createAuthenticatedWSS({
  port,
  auth0Domain,
  auth0Audience,
  allowedOrigins,
  createCores: (user) => new AppCore(user),
  exposeAuthConfig: { clientId: auth0ClientId }, // domain/audience reused
});
```

> `exposeAuthConfig` is valid in **`port` mode only**. When you bring your own `server`, mount `createAuthConfigHandler()` in your request handler instead (a second `request` listener would race yours) — `createAuthenticatedWSS` throws if you combine `server` with `exposeAuthConfig`.

Notes:

- You own the `http.Server`, so additional routes (`/healthz`, an Express / Fastify mount) plug in by editing the same `httpServer`. `createAuthConfigHandler` writes to `res` **only** for the config path (and its `OPTIONS`), so it co-exists with any routing you already have.
- The same `allowedOrigins` list gates the WebSocket upgrade AND the config CORS response. A request that would have been allowed to open a WebSocket is also allowed to read the config.
- `remoteUrl` is derived per request from `req.headers.host` and (when present) `X-Forwarded-Proto` so the config endpoint advertises the actual reachable URL — works unchanged on localhost, behind a reverse proxy, and on any non-localhost host. Pass a string (e.g. `PUBLIC_WS_URL`) to pin it, or a `(req) => string` function for custom derivation.
- `Cache-Control` defaults to `private, max-age=60` — `private` (not `public`) because the body's `remoteUrl` is derived per request from `Host` / `X-Forwarded-Proto`, so it must not land in a shared CDN / forward-proxy cache that could serve one host's URL to another; the browser may still cache it. `max-age=60` is short on purpose — too long would slow recovery from a tenant rotation. Override via the `cacheControl` option.
- For per-path WebSocket routing (multiple WS endpoints on one server), `{ server }` is too coarse — drop to `verifyAuth0Token` + `handleConnection` with your own `noServer` `handleUpgrade`, as the reference `handleConnection` is transport-agnostic.

## Client side — pick the variant that matches your stack

Two equivalent ways to deliver the fetched config to `<auth0-gate>`. Both rely on the same underlying fact: `<auth0-gate>` waits for `domain` + `client-id` before calling `initialize()`, so the element can be inert in the DOM until the fetch completes.

### Variant A — with `@wcstack/state` (recommended for `<wcs-state>` apps)

If the page already uses `<wcs-state>`, the cleanest wiring is to let `<auth0-config>` fetch the JSON and let `attr.*` bindings push the values onto `<auth0-gate>`. No imperative `fetch` / `setAttribute` / dynamic `import()` in HTML — `/auto` script tags load normally.

```html
<script type="module" src="https://esm.run/@csbc-dev/auth0/auto"></script>
<script type="module" src="https://esm.run/@wcstack/state/auto"></script>

<wcs-state>
  <script type="module">
    export default {
      config: {
        domain: "",
        clientId: "",
        audience: "",
        remoteUrl: "",
        loading: true,
        error: null,
      },
      redirectUri:   window.location.origin,
    };
  </script>

  <auth0-config
    src="http://localhost:3000/auth-config"
    data-wcs="
      domain:    config.domain;
      clientId:  config.clientId;
      audience:  config.audience;
      remoteUrl: config.remoteUrl;
      loading:   config.loading;
      error:     config.error
    ">
  </auth0-config>

  <auth0-gate
    id="auth"
    data-wcs="
      attr.domain:       config.domain;
      attr.client-id:    config.clientId;
      attr.audience:     config.audience;
      attr.remote-url:   config.remoteUrl;
      attr.redirect-uri: redirectUri;
      authenticated:     isLoggedIn;
      user:              currentUser;
      loading:           authLoading;
      error:             authError;
      connected:         wsConnected
    ">
  </auth0-gate>
</wcs-state>
```

Reference: [examples/wcstack-state/index.html](../../examples/wcstack-state/index.html).

### Variant B — plain HTML (no state library)

Same end state, expressed imperatively. The single hardcoded value in HTML is the **config server URL**; everything else is fetched and stamped onto `<auth0-gate>`.

```html
<script type="module" src="https://esm.run/@csbc-dev/auth0/auto"></script>

<auth0-config id="cfg" src="http://localhost:3000/auth-config"></auth0-config>
<auth0-gate id="auth"></auth0-gate>

<script type="module">
  const cfg = document.getElementById("cfg");
  const auth = document.getElementById("auth");
  await cfg.load();
  if (cfg.error) throw cfg.error;

  auth.setAttribute("domain",       cfg.domain);
  auth.setAttribute("client-id",    cfg.clientId);
  auth.setAttribute("audience",     cfg.audience);
  auth.setAttribute("remote-url",   cfg.remoteUrl);
  auth.setAttribute("redirect-uri", location.origin);
</script>
```

## Why both variants work — `<auth0-gate>` waits for its attributes

`<auth0-gate>`'s [Auth.ts:_tryInitialize](../../src/components/Auth.ts) only calls `initialize()` when both `domain` and `client-id` are truthy. If either is missing at upgrade time, `connectedCallback` becomes a no-op — no throw, no error event. When the missing attributes later arrive (via `setAttribute` directly, or via wcstack/state's `attr.*` propagation), `attributeChangedCallback` schedules a coalesced microtask that calls `initialize()` once both are present.

This means the two variants amount to the same thing: `<auth0-config>` (or your own imperative fetch) resolves the public JSON, then the values arrive on `<auth0-gate>` after upgrade via attributes. The microtask path triggers init once both `domain` and `client-id` are present.

Either is correct. Variant A is preferred when wcstack/state is already in the page (fully declarative config→state→attr propagation). Variant B is for pages that don't use a state library.

The empty initial values in Variant A (`config.domain: ""`, `config.remoteUrl: ""`) are deliberate. `<auth0-gate>`'s mode inference treats `remote-url=""` as **unset** (it does not flip into remote mode prematurely while the config is loading), and `_tryInitialize` treats `""` as falsy. Both behaviours were specifically reinforced by past quality cycles to make this pattern viable.

## Tradeoffs

| | This pattern | Static-attribute baseline |
|---|---|---|
| Static HTML in repo | Tenant values absent — only `<auth0-config src>` is hardcoded | All four values hardcoded; need per-env HTML or sed at deploy |
| Boot latency | +1 HTTP round-trip before WebSocket open | none |
| Same HTML for dev/staging/prod | yes (different `<auth0-config src>` per environment, OR a relative path if served from same origin) | no |
| Tenant rotation | server `.env` change + 60s cache window | redeploy / sed every static HTML |
| Works without CORS | only if static page and config server share origin | always |
| Works in `file://` | no | no (Auth0 SDK requires a real origin anyway) |

The HTTP round-trip is small (~5 KB JSON, single TCP/TLS) compared to the WebSocket handshake itself, but it's still latency on cold load. If you can serve the static HTML from the same origin as the WebSocket server (e.g. behind a reverse proxy that fronts both), use a relative `<auth0-config src="/auth-config">` and avoid CORS preflight altogether.

## When NOT to use this

- **Local mode**: there is no server to fetch from. Use bundler env vars (`import.meta.env.VITE_AUTH0_*`) or the sidecar `env.js` pattern.
- **Apps that already have a config endpoint**: just add `domain` / `clientId` / `audience` / `remoteUrl` to your existing `/config.json` shape and skip the new endpoint.
- **Multi-tenant SaaS**: this pattern assumes one tenant per server. If `clientId` varies per request (e.g. tenant inferred from subdomain), the endpoint should accept a tenant identifier and return the corresponding config — but at that point you're outside what `@csbc-dev/auth0` provides and into your own auth-routing layer.

## Reference implementation

- Server entry: [examples/server/server.js](../../examples/server/server.js) (thin — just the Core factory)
- Server composition: [examples/server/createExampleServer.js](../../examples/server/createExampleServer.js) (env / CORS / `/_shared/` glue wrapping the three package primitives)
- Client: [examples/wcstack-state/index.html](../../examples/wcstack-state/index.html)
- README walkthrough: [examples/wcstack-state/README.md](../../examples/wcstack-state/README.md)
