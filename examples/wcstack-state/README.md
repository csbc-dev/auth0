# @wcstack/state example

Static HTML page that uses `data-wcs` declarative bindings to wire `<auth0-gate>` + `<auth0-session>` + a payload child (`<app-core-facade>`) into a `<wcs-state>` store. CDN loaded — no bundler required.

## Setup

1. Open [`index.html`](index.html) and edit the four static attributes on `<auth0-gate>`:
   - `domain="your-tenant.auth0.com"`
   - `client-id="your-client-id"`
   - `audience="https://api.example.com"`
   - `remote-url="ws://localhost:3000"`

2. Make sure the [example server](../server/) is running (`npm run dev` from `examples/server`).

3. Add the static page's origin (e.g. `http://localhost:5175`) to the server's `ALLOWED_ORIGINS`.

4. Serve the directory with anything that produces a real Origin header — for example:

   ```bash
   npx --yes serve -l 5175 .
   # or
   python -m http.server 5175
   ```

   `file://` will not work — Auth0 SDK and CORS-aware WebSocket handshakes need a real origin.

5. Add the same origin to your Auth0 application's **Allowed Callback URLs** / **Allowed Web Origins** / **Allowed Logout URLs**.

## What this example demonstrates

- **Payload child pattern, no registry**: `<app-core-facade>` is defined inline in the head as a schema-only `HTMLElement` subclass. `<auth0-session>` adopts it as the data-plane facade; no `registerCoreDeclaration` / `core="..."` indirection.
- **`data-wcs` directly on the payload**: `<app-core-facade data-wcs="count: liveCount; lastUpdatedBy: liveAuthor">` — the session mirrors property events onto the facade element, so wcstack's binding system sees them like any other DOM-level event.
- **Command forwarders**: `<auth0-session>` installs `increment` / `decrement` / `reset` as own-property functions on the facade. The state's `increment()` method calls them via `document.querySelector("app-core-facade").increment()`.
- **`/auto` is back**: the `@csbc-dev/auth0/auto` and `@wcstack/state/auto` entries handle their own `bootstrap*()` calls. The previous "must import bootstrapAuth ourselves to guarantee the same module instance" workaround was needed because the old registry-based path required `registerCoreDeclaration` and the elements that read from it to live in the same instance. The payload-child pattern eliminates that dependency — `<auth0-session>` resolves the schema by reading `child.constructor.wcBindable`, which is module-instance agnostic.
- **`<auth0-logout target="auth">`** for declarative logout.
