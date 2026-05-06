# @csbc-dev/auth0 — Remote mode

This document covers **remote mode**: `<auth0-gate>` acts as a gatekeeper to server-side Cores over an authenticated WebSocket. The access token stays inside the Shell and is sent on the wire only at the WebSocket handshake and during in-band `auth:refresh`. **Application code does not see the token.**

In the **CSBC (Core/Shell Bindable Component)** taxonomy this is a thin browser-side gatekeeper that enables the **Case B** family: server-side Cores remain authoritative, while `<auth0-gate>` and `<auth0-session>` establish and expose the authenticated transport to the browser.

For the in-browser Auth0-only flow where the application reads the token to attach `Authorization: Bearer` headers, see [README-LOCAL.md](README-LOCAL.md).

For the protocol / server-side / threat-model details, see [SPEC-REMOTE.md](SPEC-REMOTE.md).

## Mode

Remote mode is selected when either:

- `mode="remote"` is set explicitly, or
- `remote-url` is set to a **non-empty** value (implicit — the element has a WebSocket endpoint to talk to).

`mode="local"` overrides the `remote-url` inference if you need to force local behavior.

### Empty vs unset `remote-url`

`remote-url=""` (empty string) is treated the same as **unset** for mode inference — it does **not** flip the element into remote mode. The element resolves to `local` unless `mode="remote"` is set explicitly.

This rule exists so that dynamic bindings whose initial value resolves to an empty string (template placeholders, state bound before data is loaded, framework prop defaults, etc.) do not accidentally put the element into a broken remote state where `getToken()` throws and `connect()` fails because the URL is empty.

| `mode` attr | `remote-url` attr    | Resolved `mode` |
|-------------|----------------------|-----------------|
| `"remote"`  | any (including `""`) | `remote`        |
| `"local"`   | any                  | `local`         |
| unset       | non-empty string     | `remote`        |
| unset       | `""` or absent       | `local`         |

If you want to force remote mode even while `remote-url` is temporarily empty (e.g. the URL is wired up after `connectedCallback`), set `mode="remote"` explicitly. `connect()` will still reject without a URL — use `authEl.connect(explicitUrl)` or set `remote-url` before calling it.

### Token visibility in remote mode

| API | Behavior |
|-----|----------|
| `authEl.token` | Always returns `null`. |
| `await authEl.getToken()` | Throws — the token is not exposed to application code. |
| `authEl.getTokenExpiry()` | Returns the `exp` claim as a ms epoch. No token material leaves the Shell. Use this to schedule refreshes. |
| wcBindable surface | `token` is absent (same as local mode). `connected` is included to reflect WebSocket state. |

This is the whole point of remote mode: every place in application JS where the token could be read is closed. The token still exists inside the browser — it lives in the Auth0 SPA SDK cache and briefly passes through AuthShell on its way to the `Sec-WebSocket-Protocol` header — but it is never handed to consumer code. See [SPEC-REMOTE.md §9 Security Considerations](SPEC-REMOTE.md) for the full threat model, including what this design does and does not protect against.

## Install

```bash
npm install @csbc-dev/auth0 @wc-bindable/remote @auth0/auth0-spa-js
```

`@wc-bindable/remote` provides the WebSocket transport and `createRemoteCoreProxy`. `@auth0/auth0-spa-js` is the Auth0 peer dependency (same as local mode).

## Quick Start

The recommended declarative flow uses **two elements** plus a **user-defined payload child**:

- `<auth0-gate>` — the Auth0 gatekeeper (same element as local mode).
- `<auth0-session>` — a companion that owns the remote session: calls `connect()` on login, wraps the returned transport with `createRemoteCoreProxy()`, and flips a single `ready` signal when the server's initial `sync` lands.
- A **child custom element** whose class declares `static wcBindable` matching the server-side Core's surface. The session adopts that child as its data-plane facade.

Without `<auth0-session>`, application code has to manually wire the transport → proxy → "first bind callback batch" → `synced` state machine. The session element collapses that into one declarative `ready` property.

### 1. Define your payload element

The Core's `wcBindable` declaration is the contract between client and server. Express it once as `static wcBindable` on a custom element class — same shape as the server-side Core. The element class needs no business logic; the session adopts it as a thin facade and forwards proxy events / commands onto it.

```ts
import { AppCore } from "./shared/app-core.js";  // shared with the server

class AppCoreFacade extends HTMLElement {
  // Same declaration as the server-side AppCore.
  static wcBindable = AppCore.wcBindable;
}
customElements.define("app-core-facade", AppCoreFacade);
```

There is **no string-keyed registry** in this path — the schema lives in one place (the class) and is shared by reference between server and client (e.g. via a `shared/app-core.js` module imported by both). Each session adopts its own facade instance, and `data-wcs` / `bind()` work directly against that instance.

### 2. Declare the pair in markup

Nest the payload child inside `<auth0-session>`. Bindings on the **payload child** read the Core's properties; bindings on `<auth0-session>` itself read its lifecycle (`ready`, `connecting`, `error`).

```html
<script type="module" src="https://esm.run/@csbc-dev/auth0/auto"></script>

<auth0-gate
  id="auth"
  domain="example.auth0.com"
  client-id="your-client-id"
  audience="https://api.example.com"
  remote-url="wss://api.example.com/ws"
  data-wcs="
    authenticated: isLoggedIn;
    user: currentUser;
    connected: wsConnected
  ">
</auth0-gate>

<auth0-session
  target="auth"
  data-wcs="
    ready: sessionReady;
    connecting: sessionConnecting;
    error: sessionError
  ">
  <app-core-facade
    data-wcs="
      count: liveCount;
      lastUpdatedBy: liveAuthor
    ">
  </app-core-facade>
</auth0-session>
```

Because `remote-url` is set, `<auth0-gate>`'s `mode` defaults to `"remote"` — `authEl.token` is `null` and `authEl.getToken()` throws. `<auth0-session>` observes the target's `authenticated`, opens the WebSocket via `authEl.connect()`, builds the proxy from the **first child whose constructor declares `wcBindable`**, mirrors property events onto that child, and fires `ready-changed` after sync completes.

### 3. Gate UI on `sessionReady` and command the Core via the payload

```html
<template data-wcs="if: sessionReady">
  <p>Count: <span data-wcs="textContent: liveCount"></span></p>
  <button data-wcs="onclick: increment">+1</button>
</template>
<template data-wcs="if: sessionConnecting">
  <p>Loading session...</p>
</template>
```

`<auth0-session>` installs each declared command as an own-property forwarder on the payload child, so `payload.increment(...args)` resolves to `proxy.invoke("increment", ...args)`. From a state binding system, expose a method that calls the forwarder:

```js
// inside <wcs-state>'s state object
increment() {
  document.querySelector("app-core-facade")?.increment();
}
```

### 4. Access proxy state from JS (when not using the payload child)

The `RemoteCoreProxy` is also exposed on the session for callers that want imperative access — useful for low-level inspection or when no payload child is in play:

```ts
import { bind } from "@wc-bindable/core";

const session = document.querySelector("auth0-session");
await session.connectedCallbackPromise;

bind(session.proxy, (name, value) => {
  // Same updates as those mirrored onto the payload child, raw from the proxy.
});
```

### Legacy: `core="..."` attribute + registry

Before the payload-child pattern existed, sessions resolved their Core declaration through a **process-wide string registry**. This path still works and is selected when `<auth0-session>` has no wc-bindable child:

```ts
import { registerCoreDeclaration } from "@csbc-dev/auth0";
import { AppCore } from "./my-app-core.js";

registerCoreDeclaration("app-core", AppCore.wcBindable);
```

```html
<auth0-session target="auth" core="app-core"></auth0-session>
```

Re-registering the same key with an identical reference is idempotent; a different declaration throws to keep already-mounted sessions consistent. For HMR, pair the registration with `unregisterCoreDeclaration(key)` in `import.meta.hot.dispose`. With the payload-child pattern, none of this is necessary — prefer that path for new code.

### Alternative: imperative flow (lower-level)

Use this path **instead of** `<auth0-session>`, not in addition to it. See the Connection Ownership rule below.

```ts
import { createRemoteCoreProxy } from "@wc-bindable/remote";
import { bind } from "@wc-bindable/core";
import { AppCore } from "./my-app-core.js";

const auth = document.querySelector("auth0-gate");
await auth.connectedCallbackPromise;
await auth.login();
const transport = await auth.connect();

const proxy = createRemoteCoreProxy(AppCore.wcBindable, transport);

let firstBatch = true;
bind(proxy, (name, value) => {
  if (firstBatch) {
    firstBatch = false;
    queueMicrotask(() => {/* sync complete — render UI */});
  }
  // Apply update ...
});
```

> **Don't gate UI on `auth.connected` alone.** `connected` becomes `true` when the WebSocket opens (stage 1); the server-side Core is only ready after the sync exchange completes (stage 2). `<auth0-session>`'s `ready` is the correct stage-2 signal. See [SPEC-REMOTE.md §3.1 Semantics of `connected`](SPEC-REMOTE.md) for the three readiness stages.

### Connection Ownership — pick exactly one pattern

`<auth0-gate>` does **not** auto-connect by itself. Setting `remote-url` only provides the default URL that `connect()` / `<auth0-session>` will use. Something has to actually call `connect()` — and only one of the two patterns above should do so per `<auth0-gate>` instance:

| Pattern | Who calls `connect()` | Who owns the proxy |
|---------|-----------------------|--------------------|
| Declarative (recommended) | `<auth0-session>` when `authenticated` goes `true` | `<auth0-session>` (`session.proxy`) |
| Imperative | Application code | Application code |

**Do not combine them.** `AuthShell.connect()` calls `_closeWebSocket()` at the start of every invocation (a defensive invariant that keeps failed handshakes from leaking sockets). If the application calls `authEl.connect()` after `<auth0-session>` already did, the session's WebSocket is closed out from under it and its `RemoteCoreProxy` is bound to a dead transport — `ready` stays `true` but no property updates arrive. The reverse is equally broken.

As a safety net, `<auth0-session>` fails fast when it detects this conflict: if `authEl.connected === true` at the point where the session would otherwise call `connect()`, it sets `error` to a message pointing to [SPEC-REMOTE.md §3.7](SPEC-REMOTE.md) instead of building a proxy. This surfaces the mistake loudly rather than producing a session that silently goes quiet.

The same rule extends to **multiple `<auth0-session>` elements** pointing at the same `<auth0-gate>`: only one can own the connection. The second session's `connect()` is rejected by the same ownership guard. If you need to drive multiple server-side Cores (`user-core`, `billing-core`, …) from a single Auth0 session, the multiplexing is the responsibility of a layer above this package — either pair one `<auth0-gate>` with one session per Core (one WebSocket per Core), or build a single Core on the server that aggregates the sub-states and exposes them through one proxy. This package guarantees **1 `<auth0-gate>` = 1 connection = 1 proxy**.

## Token Refresh

Access tokens expire (typically 300–900s). The remote deployment uses **in-band refresh** as the primary strategy: the client periodically obtains a fresh token from Auth0 and sends it to the server over the existing WebSocket. Core state is not rebuilt.

### Scheduling

Do not use a fixed `setInterval`. Decode the `exp` claim and schedule the refresh relative to expiry, with a safety margin. The `exp` is reachable without touching the token material:

```ts
const expiresAt = auth.getTokenExpiry();  // ms epoch, or null
if (expiresAt !== null) {
  const delay = Math.max(0, expiresAt - Date.now() - 30_000);  // 30s margin
  setTimeout(() => auth.refreshToken(), delay);
}
```

### Failure handling — don't drop straight to logout

`refreshToken()` can fail for reasons that are **not** terminal: a momentary network drop, the tab being backgrounded across the scheduled fire time, a transient server restart. Treating every failure as "log the user out" is user-hostile. The recommended escalation ladder:

1. **`refreshToken()` rejects** — try `authEl.reconnect()` (Strategy B / §3.4.2 — fresh token, fresh WebSocket, server rebuilds Cores) with exponential backoff.
2. **Reconnect also fails, repeatedly** — only then call `authEl.logout()`.
3. **Short-circuit on auth errors.** If the failure's shape is `login_required` / `consent_required`, a `4401`/`4403` close code, or mentions `invalid_token` / `revoked`, the refresh token itself is dead — no retry will help, go straight to logout.

SPEC-REMOTE §3.4.1 ships a full `scheduleTokenRefresh(authShell, proxy, options)` reference implementation with configurable `maxReconnectAttempts`, `initialBackoffMs`, `maxBackoffMs`, and `isAuthError` classifier. Copy it into your app rather than inlining an ad-hoc `catch { logout(); }`.

### APIs

| Method | Description |
|--------|-------------|
| `connect(url?)` | Open authenticated WebSocket. Returns a `ClientTransport`. Uses `remote-url` if omitted. |
| `refreshToken()` | In-band refresh — fresh token delivered over the existing WebSocket. Core state continuous. See [SPEC-REMOTE.md §3.4.1](SPEC-REMOTE.md). |
| `reconnect()` | Close the current WebSocket, refresh the token, open a new one. Server rebuilds Cores from scratch. Use for crash recovery, not routine renewal. See [SPEC-REMOTE.md §3.4.2](SPEC-REMOTE.md). |
| `getTokenExpiry()` | `number \| null` — current token's `exp` in ms epoch. **Does not expose token material.** |
| `logout(options?)` | Logout from Auth0 and close the WebSocket. |

See [SPEC-REMOTE.md §3.4](SPEC-REMOTE.md) for the full refresh model including the fetch-then-commit invariant and fallback semantics.

## State Surface

### Output state (bindable)

| Property | Type | Description |
|----------|------|-------------|
| `authenticated` | `boolean` | `true` when the user is logged in to Auth0 |
| `user` | `AuthUser \| null` | User profile from Auth0 |
| `loading` | `boolean` | `true` during initialization or login |
| `error` | `AuthError \| Error \| null` | Authentication error |
| `connected` | `boolean` | WebSocket transport open (**remote mode only**) |

### Input / command surface

| Property | Type | Description |
|----------|------|-------------|
| `domain` | `string` | Auth0 tenant domain |
| `client-id` | `string` | Auth0 application client ID |
| `audience` | `string` | API audience identifier. Technically optional on `<auth0-gate>`, but **required in remote mode** — `connect()` / `reconnect()` reject synchronously when `mode === "remote"` and `audience` is missing, because the server's `verifyAuth0Token` would otherwise close the just-opened WebSocket with `1008 Unauthorized` on `aud` mismatch (a far-from-call-site failure). Set this to the API identifier registered in your Auth0 tenant. |
| `remote-url` | `string` | WebSocket endpoint. Setting this to a **non-empty** value infers `mode="remote"`. An empty `remote-url=""` is treated as unset for mode inference (see [§Empty vs unset `remote-url`](#empty-vs-unset-remote-url)). |
| `mode` | `"local" \| "remote"` | Explicit deployment mode |
| `trigger` | `boolean` | One-way login trigger |

## Error contract

Remote mode keeps the same **observable error** default as local mode: Auth0 SDK failures resolve and surface via the `error` property / `auth0-gate:error` event, not as rejected promises. Remote mode adds one layer on top — WebSocket I/O failures — which **do** reject so callers can branch on reconnect / retry logic.

### Resolve (observable via `error`)

| Method | On Auth0 SDK failure |
|--------|----------------------|
| `authEl.initialize()` | resolves; `error` set, `loading` cleared |
| `authEl.login(options?)` | resolves; `error` set, `loading` cleared |
| `authEl.logout(options?)` | resolves; `error` set |

The `trigger` one-way command follows the same contract.

### Reject (catch-and-observe)

| Method | Rejects on |
|--------|------------|
| `authEl.connect(url?)` | missing URL, **missing `audience` in remote mode**, missing token, WebSocket handshake failure |
| `authEl.reconnect()` | no prior URL, **missing `audience` in remote mode**, token fetch failure, WebSocket handshake failure |
| `authEl.refreshToken()` | no active connection, token fetch failure, server `throw` frame, timeout (30 s), transport close / error |
| `authEl.getToken()` | always throws in remote mode (token is not reachable from JS by design) |

```js
try {
  transport = await authEl.connect();
} catch (err) {
  // Also observable via `authEl.error` — pick one as authoritative
  // (caller-side branching here vs. declarative UI from `error`).
}
```

Both the rejected error and `authEl.error` carry the same failure. To avoid double-handling, decide per call site which channel is authoritative — typically `connect` / `reconnect` / `refreshToken` in retry orchestration use the caller-side branch, while passive UI binds `error` for display.

### Interaction with `<auth0-session>`

`<auth0-session>` internally awaits `connect()` and forwards failures through its own `error` / `ready` state. Application code binding to the session element should treat its `error` as authoritative and does not need to wrap session-managed connections in `try / catch`.

## `<auth0-session>` reference

The companion element that turns the three-stage readiness sequence (authenticated → WebSocket connected → first sync batch delivered) into one declarative `ready` signal.

### Attributes

| Attribute | Type | Default | Description |
|-----------|------|---------|-------------|
| `target` | `string` | — | ID of the paired `<auth0-gate>` element. |
| `core` | `string` | — | **Legacy fallback.** Key for a registered Core declaration. Used only when no wc-bindable child is nested inside the session. New code should prefer the [payload-child pattern](#1-define-your-payload-element). |
| `url` | `string` | — | WebSocket URL override. Falls back to the target's `remote-url`. **Read once per `_startWatching()` cycle.** Dynamic changes to either `<auth0-session>`'s `url` or the target `<auth0-gate>`'s `remote-url` AFTER the session has connected are NOT observed — the URL must be set before the session begins watching, or you must `start()` the session manually after the change. (`<auth0-session>`'s `attributeChangedCallback` re-runs `_startWatching()` only when the session is idle — `target` / `core` / `url` / `auto-connect` mutations against an already-open transport are coalesced but ignored until teardown.) |
| `auto-connect` | `boolean` | `true` | Start the session automatically on `connectedCallback`. Set `auto-connect="false"` to defer and call `.start()` imperatively. |

### Bindable output state

| Property | Type | Description |
|----------|------|-------------|
| `ready` | `boolean` | `true` once the proxy has delivered its first batch of sync values — the true "session ready" signal. |
| `connecting` | `boolean` | `true` between `connect()` start and either `ready=true` or `error`. |
| `error` | `Error \| null` | Any error from target resolution, payload resolution, transport handshake, or proxy construction. |

### JS-only accessors

| Property / Method | Description |
|-------------------|-------------|
| `.proxy` | `RemoteCoreProxy \| null` — the bound proxy. Use `bind(session.proxy, ...)` to subscribe to Core properties when no payload child is present. |
| `.transport` | `ClientTransport \| null` — the transport returned by `authEl.connect()`. |
| `.payload` | `HTMLElement \| null` — the wc-bindable child element adopted as the data-plane facade. `null` when the session is using the legacy `core="..."` registry path or has not yet started. |
| `.start()` | Manually start the session (when `auto-connect="false"`, or to retry after an error). |

### Lifecycle

1. On `connectedCallback`, defers one microtask so sibling `<auth0-gate>` has a chance to upgrade.
2. Resolves `target` by ID. Failure sets `.error` and stops.
3. **Discovery — payload child first**: scans direct light-DOM children for the first element where `isWcBindable(child)` is true. If at least one custom-element child has not yet been upgraded, awaits `customElements.whenDefined()` for it. The first wc-bindable child wins (SPEC-REMOTE §3.7 caps the connection at one proxy).
4. **Discovery fallback — `core` attribute**: when no wc-bindable child is present and `core` is set, looks up the declaration in the process-wide registry. With neither source available, sets `.error` and stops.
5. Awaits the target's `connectedCallbackPromise`, then listens for `auth0-gate:authenticated-changed`.
6. When the target is (or becomes) authenticated: calls `authEl.connect(url || target.remoteUrl)`, wraps the transport with `createRemoteCoreProxy(declaration, transport)`, installs command forwarders on the payload child (when present), and subscribes via `bind()`.
7. Each property update arriving on the proxy is mirrored onto the payload child as both an own data property (`child[name] = value`) and a re-dispatch of the user's declared event — so `data-wcs="prop: ..."` and `bind(child, ...)` observe a live state surface.
8. The first bind callback queues a microtask that flips `ready` to `true` — this defers to the end of the initial sync batch, matching the `firstBatch` pattern from [SPEC-REMOTE §11](SPEC-REMOTE.md).
9. When `authenticated` flips back to `false` (logout): tears down the proxy / bind subscription, removes the own-properties / forwarders we installed on the payload child, clears `ready`, and clears `.payload`. The WebSocket itself is owned by the target `<auth0-gate>`.

### Payload child contract

The session adopts the **first direct child** for which `target.constructor.wcBindable.protocol === "wc-bindable" && version === 1`. The schema lives once in the user's element class:

```ts
class MyPayload extends HTMLElement {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "count",         event: "my-payload:count-changed" },
      { name: "lastUpdatedBy", event: "my-payload:last-updated-by-changed" },
    ],
    commands: [{ name: "increment" }, { name: "decrement" }, { name: "reset" }],
  };
}
customElements.define("my-payload", MyPayload);
```

What `<auth0-session>` does to the adopted child while the session is live:

| Mechanism | Effect |
|-----------|--------|
| Property mirror | `child[propName] = value` is written as a configurable, writable, enumerable own data property each time the proxy fires that property's event. The mirror happens BEFORE the re-dispatch so any listener that reads `child[name]` after receiving the dispatch sees the up-to-date value. |
| Event re-dispatch | The user's declared `event` name (NOT the proxy's synthetic per-property event) is dispatched on the child — so `bind(child, ...)` from `@wc-bindable/core` and `data-wcs="prop: ..."` work directly against the child. |
| Command forwarder | For each declared command, `child[cmdName]` is installed as a non-enumerable own-property function that delegates to `proxy.invoke(cmdName, ...args)` and returns the proxy's promise. Installed up-front (before the first sync) so callers can invoke commands as soon as the transport is open. |
| Teardown cleanup | On logout / disconnect / element removal, every own-property the session installed is deleted via identity comparison — values mirrored from the proxy and command forwarders are removed only when the descriptor still matches what the session wrote. A user replacement made mid-session is left untouched. |

The user's element class is intentionally **schema-only** — no methods, no constructor logic, no shadow DOM are required. If users add their own methods of the same name as a declared command, the session's forwarder shadows them as an own-property for the duration of the session and lifts the shadow on teardown so the prototype method comes back.

### Legacy registry path

When no wc-bindable child is present, the session falls back to looking up the declaration by string key:

| Function | Description |
|----------|-------------|
| `registerCoreDeclaration(key, declaration)` | Register a Core's `wcBindable` under a string key. Throws if the key is already registered with a different declaration. Idempotent for identical re-registration. |
| `getCoreDeclaration(key)` | Look up a declaration. Returns `undefined` if not registered. |
| `unregisterCoreDeclaration(key)` | Remove an entry. Already-mounted sessions keep their captured declarations. |

The registry is process-wide. Prefer the payload-child pattern for new code: it removes the string-keyed indirection, the HMR dispose dance, and the same-module-instance gotcha that bites CDN deployments where `/auto` and the main entry can resolve to different module instances.

### Why `token` is absent from both surfaces

In remote mode the server holds the authoritative session. There is no application-level API call that application JS needs to attach a token to — the WebSocket connection itself is the authenticated session. Exposing the token to application code would create leakage vectors (component trees, framework state, DevTools property panels) with no corresponding use case.

This is a **defense-in-depth** measure, not a security boundary. Any JS running in the same origin can still reach `auth0Client.getTokenSilently()` directly, and a browser extension with `webRequest` permissions can read the `Sec-WebSocket-Protocol` handshake header. See [SPEC-REMOTE.md §9.0 Threat Model and Honest Boundaries](SPEC-REMOTE.md) for what this design does and does not protect against.

## Server Side

The server accepts WebSocket connections, extracts the token from `Sec-WebSocket-Protocol`, verifies it via Auth0 JWKS, and constructs Cores only after verification succeeds.

```ts
import { createAuthenticatedWSS } from "@csbc-dev/auth0/server";

const wss = await createAuthenticatedWSS({
  port: 3000,
  auth0Domain: "example.auth0.com",
  auth0Audience: "https://api.example.com",
  allowedOrigins: ["https://app.example.com"],
  createCores: (user) => new AppCore(user),
  onTokenRefresh: (core, user) => core.updateUser(user),
});
```

For handler options, protocol error codes, `verifyAuth0Token()` utility, and RBAC propagation on refresh, see [SPEC-REMOTE.md §5 Server Side](SPEC-REMOTE.md) and §3.6 onwards.

### Resource & rate-limit knobs

| Option | Default | Effect |
|--------|---------|--------|
| `maxPayload` | `262144` (256 KiB) | Maximum WebSocket message size. Forwarded to `new WebSocketServer({ maxPayload })`. The `ws` library defaults to 100 MiB, far larger than any legitimate `auth:refresh` (a JWT — a few KiB) or normal RPC frame; the lower default caps the per-frame memory a single client can pin. Override only if your application legitimately pushes larger frames. |
| `minRefreshIntervalMs` | `5_000` | Minimum interval (ms) between successful in-band `auth:refresh` operations on a single connection. A refresh arriving within the window is rejected with `auth:refresh-failure` BEFORE `verifyAuth0Token` / `onTokenRefresh` runs. Defends against a client that loops on refresh (bug or hostile probe) — without the gate every iteration would run a JWKS round-trip and signature check. Set to `0` to disable. |

`verifyAuth0Token` accepts an additional knob for clock skew:

| Option | Default | Effect |
|--------|---------|--------|
| `clockTolerance` | `"30s"` | Forwarded to `jose`'s `jwtVerify` for `exp` / `iat` / `nbf` checks. Accepts seconds (number) or a duration string (`"30s"`, `"2m"`). Without it, normal NTP drift between Auth0 and the verifying server surfaces as `"exp" claim timestamp check failed` / `"iat" claim timestamp check failed` rejections — closing the WebSocket with `1008` mid-handshake on a token that should have been accepted. |

### Session expiry hardening

The server extracts `exp` from the verified JWT and enforces a hard close (code `4401 Session expired`) once `exp + sessionGraceMs` elapses. Two knobs control this:

| Option | Default | Effect |
|--------|---------|--------|
| `sessionGraceMs` | `60_000` | Milliseconds added to `exp` before the forced close. Set to `0` to disable expiry enforcement. |
| `expParseFailurePolicy` | `"allow"` | How to handle tokens whose `exp` cannot be parsed (missing claim, malformed payload, non-numeric `exp`). `"allow"` falls back to `Infinity` (unbounded, but emits `auth:exp-parse-failure`). `"close"` rejects the handshake and rejects in-band refreshes, keeping sessions bounded. |

Recommended for production deployments that require a bounded session lifetime even under IdP misconfiguration:

```ts
const wss = await createAuthenticatedWSS({
  port: 3000,
  auth0Domain: "...",
  auth0Audience: "...",
  createCores: (user) => new AppCore(user),
  sessionGraceMs: 30_000,
  expParseFailurePolicy: "close",
  onEvent: (e) => {
    if (e.type === "auth:exp-parse-failure") {
      logger.warn("JWT exp unparseable — connection rejected under strict policy", e.error);
    }
  },
});
```

Under `"close"`:

- **Initial handshake:** the socket is rejected before `createCores` runs (no server-side side effects), `auth:exp-parse-failure` fires followed by `auth:failure`, and the caller closes with `1008 Unauthorized`.
- **In-band `auth:refresh`:** the refresh is rejected with a `throw` response and `auth:refresh-failure`. The previously honoured deadline stays in effect — the connection still closes at the original `exp + sessionGraceMs` and does not become unbounded.

## TypeScript Types

```ts
import type {
  AuthUser, AuthError,
  AuthShellValues, AuthValues,
  AuthShellOptions, AuthMode,
  UserContext, AuthenticatedConnectionOptions, VerifyTokenOptions,
} from "@csbc-dev/auth0";
```

```ts
// Shell — the bindable surface exposed to remote / DOM binding.
// Token is intentionally absent; `connected` is included.
interface AuthShellValues {
  authenticated: boolean;
  user: AuthUser | null;
  loading: boolean;
  error: AuthError | Error | null;
  connected: boolean;
}

// <auth0-gate> custom element — extends the Shell with `trigger`.
interface AuthValues extends AuthShellValues {
  trigger: boolean;
}

type AuthMode = "local" | "remote";
```

## Framework Integration

Same as local mode — the custom element implements wc-bindable-protocol, so React/Vue/Svelte/Solid adapters just read `authenticated`, `user`, `loading`, `error`, `connected` through `useWcBindable` / equivalent. See [README-LOCAL.md §Framework Integration](README-LOCAL.md) for snippets; the only difference is that in remote mode you'll also want `connected`, and you must not read `token`.

## See Also

- [README-LOCAL.md](README-LOCAL.md) — Auth0-only local flow
- [SPEC-REMOTE.md](SPEC-REMOTE.md) — Full remote protocol spec: server implementation, error codes, refresh semantics, security model
