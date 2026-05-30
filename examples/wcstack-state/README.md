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

2. (Optional) Open [`index.html`](index.html) and adjust the two server URLs if your server is not at `http://localhost:3000`: `CONFIG_URL` (the `/auth-config` endpoint) and the `<script src="…/_shared/appCoreFacade.auto.js">` tag that loads the payload facade definition. Both point at the same example server.

3. Make sure the static page's origin (e.g. `http://localhost:5176`) is in the server's `ALLOWED_ORIGINS`. The default `.env.example` already lists `5173`–`5176`, so `5176` works out of the box. The same allowlist gates both the WebSocket upgrade and the `/auth-config` CORS response.

4. Serve the directory with anything that produces a real Origin header — for example:

   ```bash
   npx --yes serve -l 5176 .
   # or
   python -m http.server 5176
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

The empty initial values are deliberate: `<auth0-gate>` treats empty `remote-url=""` as "unset" (mode stays in inference mode rather than flipping into remote prematurely), and `_tryInitialize()` requires both `domain` AND `client-id` to be truthy before calling Auth0. Until the fetch completes, the gate sits inert with `loading` true, and `data-wcs="loading: authLoading"` keeps the `statusMessage` line on "Loading Auth0…". (Status is a single `{{ statusMessage }}` getter, not one `if:` template per state — `data-wcs`'s `if:` has no `&&`/`||`, so independent conditions could not be made mutually exclusive.)

## What this example demonstrates

- **Server-config-discovery via `$connectedCallback` + `attr.*`**: fetch happens inside the state's lifecycle hook; wcstack/state propagates state→attribute changes onto `<auth0-gate>` automatically. No imperative `customElements.whenDefined()` / dynamic `import()` dance — `/auto` script tags load normally and the element waits for attributes to arrive.
- **Payload child pattern, no registry, single source of truth**: `<app-core-facade>` is a schema-only `HTMLElement` subclass defined by `../shared/appCoreFacade.js`, which the example server serves over its `/_shared/` static mount (loaded via `<script src="http://localhost:3000/_shared/appCoreFacade.auto.js">`). Its schema therefore comes from the same `appCoreDeclaration` the server-side `AppCore` uses — no hand-written duplicate in the HTML to keep in sync. `<auth0-session>` adopts it as the data-plane facade (awaiting `customElements.whenDefined()` so the cross-origin async define is race-free); no `registerCoreDeclaration` / `core="..."` indirection.
- **Spread-aware binding on `<auth0-gate>`**: the gate's `static wcBindable` now declares three surfaces — `properties` (the five state outputs authenticated / user / loading / error / connected, **plus `trigger`** — which is also an input), `inputs` (domain / client-id / audience / scope / redirect-uri / cache-location / use-refresh-tokens / remote-url / mode / trigger, most mapped to a kebab-case attribute), and `commands` (login / logout / getToken / connect / refreshToken / reconnect). This page binds the five state outputs and ignores `trigger` (login goes through the `login` command, below). Because wcstack/state's `...:` spread expands **`properties` + `inputs`**, a blanket `...: auth` would also drive every input and collide with the explicit `attr.*` config writes — so the page binds the gate's five outputs explicitly and writes config through `attr.*`. The payload facade still uses `...: live` because it declares **no `inputs`** (its spread is properties-only). Login uses one entry of the gate's `commands` surface — `command.login: $command.login` (see the next bullet); logout goes through `<auth0-logout>`; the remaining commands (getToken / connect / refreshToken / reconnect) are not needed here.
- **`data-wcs` directly on the payload**: `<app-core-facade data-wcs="...: live; …">` — `<auth0-session>` mirrors the server Core's `count` / `connectedUser` as events on the facade element (and installs the command forwarders), so wcstack/state binds them like any other DOM-level event — here via `...: live` into the nested `live.count` / `live.connectedUser`, with no bridging code in state.
- **Command tokens (no `document.querySelector` in state)**: state declares `$commandTokens: ["login", "increment", "decrement", "reset"]`. `increment` / `decrement` / `reset` subscribe the facade via `data-wcs="command.increment: $command.increment; …"` (the `<auth0-session>`-installed forwarders route to `proxy.invoke()` over the WebSocket), and `login` subscribes `<auth0-gate>`'s own native `login()` via `command.login: $command.login`. The right-hand side uses the `$command.<name>` namespace because wcstack/state does **not** inject tokens at the state root — they live only on the `$command` proxy (avoids name collisions with reactive properties). `command.<name>` is validated at binding time against the target element's `static wcBindable.commands`, so a typo is caught immediately. The count buttons emit straight from the markup (`onclick: $command.increment`), but **`login` emits from a `login()` state method instead** — a command subscriber forwards the emit payload to the target (`el.login(payload)`), and the gate's real `login(options)` feeds its first arg into Auth0 as `authorizationParams`; emitting the click `Event` directly would push a `MouseEvent` in there. `login()` calls `this.$command.login.emit()` with **no payload** so `el.login()` stays clean (the facade's count commands avoid this only because their session-installed forwarders ignore arguments). `login()` also `allSettled`s the emit result to swallow the one precondition rejection (Sign in clicked before the Auth0 client is initialized).
- **`<auth0-logout target="auth">`** for declarative logout.
