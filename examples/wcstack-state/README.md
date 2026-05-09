# @wcstack/state example

Static HTML page that uses `data-wcs` declarative bindings to wire `<auth0-gate>` + `<auth0-session>` + a payload child (`<app-core-facade>`) into a `<wcs-state>` store. CDN loaded — no bundler required.

This example uses **server-config-discovery** (see [docs/patterns/server-config-discovery.md](../../docs/patterns/server-config-discovery.md)) so you only need to edit one URL in the HTML; tenant values (Auth0 domain / client-id / audience, plus the WebSocket URL) come from the example server's `/auth-config` endpoint at boot.

The fetch is wired through `<wcs-state>`'s `$connectedCallback` lifecycle hook and `attr.*` bindings — no manual `setAttribute` / `customElements.whenDefined` plumbing in the page.

## Setup

1. Start the example server first — its `.env` holds the tenant values that this static page will read:

   ```bash
   cd ../server
   cp .env.example .env       # edit AUTH0_DOMAIN / AUTH0_CLIENT_ID / AUTH0_AUDIENCE
   npm install
   npm run dev                # ws://localhost:3000  +  http://localhost:3000/auth-config
   ```

2. (Optional) Open [`index.html`](index.html) and adjust `CONFIG_URL` if your server is not at `http://localhost:3000`. This is the **only** value you might need to change in the HTML.

3. Make sure the static page's origin (e.g. `http://localhost:5175`) is in the server's `ALLOWED_ORIGINS`. The same allowlist gates both the WebSocket upgrade and the `/auth-config` CORS response.

4. Serve the directory with anything that produces a real Origin header — for example:

   ```bash
   npx --yes serve -l 5175 .
   # or
   python -m http.server 5175
   ```

   `file://` will not work — Auth0 SDK and CORS-aware fetch / WebSocket handshakes need a real origin.

5. Add the same origin to your Auth0 application's **Allowed Callback URLs** / **Allowed Web Origins** / **Allowed Logout URLs**.

## How config-discovery works in this example

```
[t0] /auto bundles load
     <auth0-gate id="auth"> upgrades with empty domain / client-id
     → _tryInitialize() bails (waiting for both attributes)

[t1] <wcs-state>'s $connectedCallback fires
     → fetch(CONFIG_URL) → state.auth0Domain / .auth0ClientId / ... assigned

[t2] wcstack/state's attr.* bindings propagate state → attribute
     → setAttribute("domain", ...) × N on <auth0-gate>
     → attributeChangedCallback's microtask coalesces them into a
       single initialize() call

[t3] Auth0 init resolves → authenticated / user / loading flow into
     the data-wcs bindings → UI re-renders
```

The empty initial values are deliberate: `<auth0-gate>` treats empty `remote-url=""` as "unset" (mode stays in inference mode rather than flipping into remote prematurely), and `_tryInitialize()` requires both `domain` AND `client-id` to be truthy before calling Auth0. Until the fetch completes, the gate sits inert and `data-wcs="loading: authLoading"` shows the "Loading Auth0…" template.

## What this example demonstrates

- **Server-config-discovery via `$connectedCallback` + `attr.*`**: fetch happens inside the state's lifecycle hook; wcstack/state propagates state→attribute changes onto `<auth0-gate>` automatically. No imperative `customElements.whenDefined()` / dynamic `import()` dance — `/auto` script tags load normally and the element waits for attributes to arrive.
- **Payload child pattern, no registry**: `<app-core-facade>` is defined inline in the head as a schema-only `HTMLElement` subclass. `<auth0-session>` adopts it as the data-plane facade; no `registerCoreDeclaration` / `core="..."` indirection.
- **`data-wcs` directly on the payload**: `<app-core-facade data-wcs="count: liveCount; lastUpdatedBy: liveAuthor">` — the session mirrors property events onto the facade element, so wcstack's binding system sees them like any other DOM-level event.
- **Command forwarders**: `<auth0-session>` installs `increment` / `decrement` / `reset` as own-property functions on the facade. The state's `increment()` method calls them via `document.querySelector("app-core-facade").increment()`.
- **`<auth0-logout target="auth">`** for declarative logout.
