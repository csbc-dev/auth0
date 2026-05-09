# Pattern: server-config-discovery

A documented pattern for **remote-mode** deployments where the static client should not bake `domain` / `client-id` / `audience` / `remote-url` into HTML — typically because the same HTML is shipped to multiple environments (dev/staging/prod) or hosted off a CDN.

The server (`createAuthenticatedWSS`) already holds the same tenant values it needs to verify tokens. This pattern lets the static client fetch those values at boot from a small **`GET /auth-config`** endpoint mounted on the same port as the WebSocket, then stamp them onto `<auth0-gate>` before the custom element is upgraded.

> Status: **documented pattern, not a built-in feature** of `@csbc-dev/auth0`. Each application's HTTP layer and config schema differ enough that a one-size-fits-all `exposeAuthConfig` option would lock in too many decisions. If your usage matches this pattern closely, copy it into your server / static client; if you need richer discovery (multiple tenants, feature flags, RBAC defaults), extend the JSON shape on your side.

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
      │ 3. setAttribute on <auth0-gate>            │
      │    (still HTMLUnknownElement at this point)│
      │                                            │
      │ 4. dynamic import("@csbc-dev/auth0/auto")  │
      │    → customElements.define triggers upgrade│
      │    → connectedCallback runs with attrs set │
      │                                            │
      │ 5. <auth0-gate> opens WebSocket            │
      ├───────────────────────────────────────────►│  (normal handshake
      │                                            │   per SPEC-REMOTE.md)
```

## Server side (~30 lines)

The example server wires this on top of `createAuthenticatedWSS` by replacing the underlying `http.Server`'s default 426 response handler. The server already exists — `ws` creates one when you pass `port` — and we just route one extra path through it.

```js
// examples/server/server.js (excerpt — see file for full version)
import { createAuthenticatedWSS } from "@csbc-dev/auth0/server";

const wss = await createAuthenticatedWSS({
  port,
  auth0Domain,
  auth0Audience,
  allowedOrigins,
  createCores: (user) => new AppCore(user),
  // ...
});

const httpServer = wss._server;             // http.Server that ws created
httpServer.removeAllListeners("request");
httpServer.on("request", (req, res) => {
  // CORS: reuse the same allowlist as verifyClient.
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
    res.setHeader("Cache-Control", "public, max-age=60");
    res.end(JSON.stringify({
      domain:    auth0Domain,
      clientId:  auth0ClientId,
      audience:  auth0Audience,
      remoteUrl: `ws://localhost:${port}`,
    }));
    return;
  }

  // ws's default response for non-upgrade traffic.
  const body = "Upgrade Required";
  res.writeHead(426, { "Content-Type": "text/plain", "Content-Length": String(body.length) });
  res.end(body);
});
```

Notes:

- `wss._server` is a private-but-stable property of the `ws` library when you construct with `{ port }`. It has been the same name across `ws@7` / `ws@8` and is widely used by the ecosystem. Production deployments that want a fully public API surface should construct `WebSocketServer({ noServer: true, ... })` against an http.Server / Express / Fastify instance they own and apply this package's `verifyClient` and `handleConnection` directly.
- The same `allowedOrigins` list gates the WebSocket upgrade AND the HTTP CORS response. A request that would have been allowed to open a WebSocket is also allowed to read the config.
- `Cache-Control: max-age=60` is short on purpose — too long would slow recovery from a tenant rotation.

## Client side — pick the variant that matches your stack

Two equivalent ways to deliver the fetched config to `<auth0-gate>`. Both rely on the same underlying fact: `<auth0-gate>` waits for `domain` + `client-id` before calling `initialize()`, so the element can be inert in the DOM until the fetch completes.

### Variant A — with `@wcstack/state` (recommended for `<wcs-state>` apps)

If the page already uses `<wcs-state>`, the cleanest wiring is to fetch inside the state's `$connectedCallback` lifecycle hook and let `attr.*` bindings push the values onto `<auth0-gate>`. No imperative `setAttribute` / dynamic `import()` in HTML — `/auto` script tags load normally.

```html
<script type="module" src="https://esm.run/@csbc-dev/auth0/auto"></script>
<script type="module" src="https://esm.run/@wcstack/state/auto"></script>

<wcs-state>
  <script type="module">
    const CONFIG_URL = "http://localhost:3000/auth-config";

    export default {
      auth0Domain:   "",
      auth0ClientId: "",
      auth0Audience: "",
      remoteUrl:     "",
      redirectUri:   window.location.origin,

      // …other state…

      async $connectedCallback() {
        const res = await fetch(CONFIG_URL);
        if (!res.ok) throw new Error(`config fetch failed: HTTP ${res.status}`);
        const cfg = await res.json();
        this.auth0Domain   = cfg.domain;
        this.auth0ClientId = cfg.clientId;
        this.auth0Audience = cfg.audience;
        this.remoteUrl     = cfg.remoteUrl;
      },
    };
  </script>

  <auth0-gate
    id="auth"
    data-wcs="
      attr.domain:       auth0Domain;
      attr.client-id:    auth0ClientId;
      attr.audience:     auth0Audience;
      attr.remote-url:   remoteUrl;
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

Same end state, expressed imperatively. The single hardcoded value in HTML is the **config server URL**; everything else is fetched and stamped onto `<auth0-gate>` before the custom element upgrades.

```html
<auth0-gate id="auth"></auth0-gate>

<script type="module">
  const CONFIG_URL = "http://localhost:3000/auth-config";

  const cfg = await fetch(CONFIG_URL).then((r) => {
    if (!r.ok) throw new Error(`config fetch failed: HTTP ${r.status}`);
    return r.json();
  });

  // Element exists as HTMLUnknownElement at this point — the /auto
  // bundle's customElements.define() has not been called yet.
  const auth = document.getElementById("auth");
  auth.setAttribute("domain",       cfg.domain);
  auth.setAttribute("client-id",    cfg.clientId);
  auth.setAttribute("audience",     cfg.audience);
  auth.setAttribute("remote-url",   cfg.remoteUrl);
  auth.setAttribute("redirect-uri", location.origin);

  // Dynamic-import the /auto bundle AFTER the attributes are set.
  // customElements.define() inside the bundle will then upgrade
  // the element in place, calling connectedCallback with all attrs
  // already in their final values.
  await import("https://esm.run/@csbc-dev/auth0/auto");
</script>
```

## Why both variants work — `<auth0-gate>` waits for its attributes

`<auth0-gate>`'s [Auth.ts:_tryInitialize](../../src/components/Auth.ts) only calls `initialize()` when both `domain` and `client-id` are truthy. If either is missing at upgrade time, `connectedCallback` becomes a no-op — no throw, no error event. When the missing attributes later arrive (via `setAttribute` directly, or via wcstack/state's `attr.*` propagation), `attributeChangedCallback` schedules a coalesced microtask that calls `initialize()` once both are present.

This means the two variants amount to the same thing:

- **Variant A** lets the upgrade happen first (with empty attributes) and pushes values via state binding afterward. The microtask path triggers init.
- **Variant B** sets attributes BEFORE `customElements.define()` runs, so `attributeChangedCallback` (during upgrade) and `connectedCallback` see fully-populated values immediately. The synchronous `_tryInitialize` path triggers init.

Either is correct. Variant A is preferred when wcstack/state is already in the page (same lifecycle hook, declarative state→attr propagation). Variant B is for pages that don't use a state library or that want to keep the bootstrap entirely in `<head>`.

The empty initial values in Variant A (`auth0Domain: ""`, `remoteUrl: ""`) are deliberate. `<auth0-gate>`'s mode inference treats `remote-url=""` as **unset** (it does not flip into remote mode prematurely while the config is loading), and `_tryInitialize` treats `""` as falsy. Both behaviours were specifically reinforced by past quality cycles to make this pattern viable.

## Tradeoffs

| | This pattern | Static-attribute baseline |
|---|---|---|
| Static HTML in repo | Tenant values absent — only `CONFIG_URL` is hardcoded | All four values hardcoded; need per-env HTML or sed at deploy |
| Boot latency | +1 HTTP round-trip before WebSocket open | none |
| Same HTML for dev/staging/prod | yes (different `CONFIG_URL` per environment, OR a relative path if served from same origin) | no |
| Tenant rotation | server `.env` change + 60s cache window | redeploy / sed every static HTML |
| Works without CORS | only if static page and config server share origin | always |
| Works in `file://` | no | no (Auth0 SDK requires a real origin anyway) |

The HTTP round-trip is small (~5 KB JSON, single TCP/TLS) compared to the WebSocket handshake itself, but it's still latency on cold load. If you can serve the static HTML from the same origin as the WebSocket server (e.g. behind a reverse proxy that fronts both), use a relative `CONFIG_URL = "/auth-config"` and avoid CORS preflight altogether.

## When NOT to use this

- **Local mode**: there is no server to fetch from. Use bundler env vars (`import.meta.env.VITE_AUTH0_*`) or the sidecar `env.js` pattern.
- **Apps that already have a config endpoint**: just add `domain` / `clientId` / `audience` / `remoteUrl` to your existing `/config.json` shape and skip the new endpoint.
- **Multi-tenant SaaS**: this pattern assumes one tenant per server. If `clientId` varies per request (e.g. tenant inferred from subdomain), the endpoint should accept a tenant identifier and return the corresponding config — but at that point you're outside what `@csbc-dev/auth0` provides and into your own auth-routing layer.

## Reference implementation

- Server: [examples/server/server.js](../../examples/server/server.js)
- Client: [examples/wcstack-state/index.html](../../examples/wcstack-state/index.html)
- README walkthrough: [examples/wcstack-state/README.md](../../examples/wcstack-state/README.md)
