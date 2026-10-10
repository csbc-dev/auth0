# CLAUDE.md

This repository (`@csbc-dev/auth0`) is a re-packaged member of the csbc-dev/arch architecture lineup, originating from [`@wc-bindable/auth0`](https://github.com/wc-bindable-protocol/wc-bindable-protocol/tree/main/packages/auth0). The two foundational documents below provide the design context required to understand the package.

---

## 1. wc-bindable-protocol overview

A framework-agnostic, minimal protocol that lets any class extending `EventTarget` declare its own reactive properties. It enables reactivity systems in React / Vue / Svelte / Angular / Solid (and others) to bind to arbitrary components without writing framework-specific glue code.

### Core idea

- Component authors declare **what** is bindable
- Framework consumers decide **how** to bind it
- Neither side needs to know the other

### How to declare

Just write a schema in the `static wcBindable` field.

```javascript
class MyFetchCore extends EventTarget {
  static wcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "value",   event: "my-fetch:value-changed" },
      { name: "loading", event: "my-fetch:loading-changed" },
    ],
    inputs:   [{ name: "url" }, { name: "method" }],   // optional
    commands: [{ name: "fetch", async: true }, { name: "abort" }],  // optional
  };
}
```

| Field | Required | Purpose |
|---|---|---|
| `properties` | ✅ | Properties whose state changes are notified via `CustomEvent` (outputs) |
| `inputs` | — | Configurable properties (inputs; declaration only — no automatic syncing) |
| `commands` | — | Callable methods (intended for remote proxies and tooling) |

### How binding works

An adapter only needs to:

1. Read `target.constructor.wcBindable`
2. Verify `protocol === "wc-bindable" && version === 1`
3. For each `property`, read `target[name]` immediately to deliver the initial value, then subscribe to `event`

`bind()` is roughly 20 lines of code at most. A framework adapter can be written in a few dozen lines.

### Out of scope (intentionally)

- Automatic two-way sync (the caller is responsible for writing inputs)
- Form integration
- SSR / hydration
- Value type validation / schema validation

### Why EventTarget

The minimum requirement is `EventTarget` rather than `HTMLElement`, so the same protocol works in non-browser runtimes such as Node.js / Deno / Cloudflare Workers. Since `HTMLElement` is a subclass of `EventTarget`, Web Components are automatically compatible.

Reference: [wc-bindable-protocol/SPEC.md](https://github.com/wc-bindable-protocol/wc-bindable-protocol/blob/main/SPEC.md)

---

## 2. Core/Shell Bindable Component (CSBC) architecture overview

An architecture built on top of wc-bindable-protocol that **moves business logic (especially asynchronous code) out of the framework layer and into the Web Component**, structurally eliminating framework lock-in.

### The problem it solves

The true source of framework migration cost is not UI compatibility but **async logic that is tightly coupled to framework-specific lifecycle APIs (`useEffect` / `onMounted` / `onMount`, …)**. Templates can be rewritten mechanically, but async code requires semantic understanding, which inflates the cost of porting it.

### Three-layer structure

1. **Headless Web Component layer** — encapsulates async work (fetch / WebSocket / timers, etc.) and state (`value`, `loading`, `error`, …). It has no UI and behaves as a pure service layer.
2. **Protocol layer (wc-bindable-protocol)** — exposes the above state to the outside via `static wcBindable` + `CustomEvent`.
3. **Framework layer** — connects to the protocol through a thin adapter and renders the received state. **No async code lives here.**

### Core / Shell separation

The headless layer is further split into two. **The sole invariant is not that "the Shell is always thin" but where authority lives**:

- **Core (`EventTarget`) — owns decisions**
  Business logic, policies, state transitions, authorization-related behavior, event dispatch. If kept DOM-free, it is portable to Node.js / Deno / Workers.
- **Shell (`HTMLElement`) — only owns work that cannot be delegated**
  Framework wiring, DOM lifecycle, browser-only operations.

The key design pattern is **target injection**: the Core's constructor accepts an arbitrary `EventTarget` and dispatches all events to it. When the Shell passes `this`, Core events fire directly from the DOM element, eliminating the need for re-dispatching.

### Four canonical cases

| Case | Core location | Shell role | Examples |
|---|---|---|---|
| A | Browser | Thin wrapper for a browser-bound Core | **`auth0-gate` (local)** |
| B1 | Server | Command-mediation / proxy-style thin Shell | **`auth0-gate` (remote)**, `ai-agent` |
| B2 | Server | Observation-only thin Shell (subscribes to a remote session) | `feature-flags` |
| C | Server | Shell that runs a browser-pinned data plane | `s3-uploader`, `passkey-auth`, `stripe-checkout` |

Case C is not a deviation from CSBC but a **first-class case**. It arises whenever a data plane must run in the browser (direct upload, WebRTC, WebUSB, the `File System Access API`, work that requires a user gesture, Stripe Elements used to stay out of PCI scope, etc.). Even when the Shell becomes thick, **as long as the Core retains decision-making authority**, it does not violate CSBC.

> Invariant:
> **The Core owns all decisions. The Shell only owns work that cannot be delegated.**

### The three boundaries it crosses

| Boundary | Crossed by | Mechanism |
|---|---|---|
| Runtime boundary | Core (`EventTarget`) | DOM-free; runs on Node / Deno / Workers |
| Framework boundary | Shell (`HTMLElement`) | Attribute mapping + `ref` binding |
| Network boundary | `@wc-bindable/remote` | Proxy EventTarget + JSON wire protocol |

`@wc-bindable/remote` is a pair of `RemoteShellProxy` (server-side) and `RemoteCoreProxy` (client-side) that pushes the Core entirely to the server while letting the client-side `bind()` keep working unchanged. WebSocket is the default transport, but it is swappable for MessagePort / BroadcastChannel / WebTransport / etc., as long as the minimal interfaces (`ClientTransport` / `ServerTransport`) are satisfied.

### Where this package fits

`@csbc-dev/auth0` **straddles cases A and B1**:

- **Local mode (Case A)**: Auth0 authentication decisions (SDK initialization, login/logout, token acquisition and refresh, session state) live inside `AuthCore` (Core, `EventTarget`) in the browser. Because it depends on the Auth0 SPA SDK and on `globalThis.location` / `globalThis.history` (redirect callbacks), this Core is browser-pinned. `<auth0-gate>` (Shell, `HTMLElement`) exposes `authenticated` / `user` / `loading` / `error` to the DOM as bindable state, while `token` is intentionally excluded from the `data-wcs` surface for safety.
- **Remote mode (Case B1)**: The application's own Core lives on the server, and `<auth0-gate>` acts as a gatekeeper for the authenticated WebSocket handshake. The access token stays inside the Shell and only crosses the wire during the handshake and during in-band `auth:refresh`. Application JS never sees the token (`getToken()` throws and `token` is `null`). Combined with `<auth0-session>`, the three-stage readiness sequence (authenticated → connected → initial sync) is collapsed into a single `ready` signal.

A server-side helper bundle is provided as `@csbc-dev/auth0/server` (`createAuthenticatedWSS` / `handleConnection` / `verifyAuth0Token` / `extractTokenFromProtocol` / `createAuthConfigHandler` / `UserCore`), which wraps `@wc-bindable/remote`'s `RemoteShellProxy` and injects token verification, expiry handling, and declarative authorization middleware. `createAuthenticatedWSS` can either own its port or attach to an existing `http.Server` via `{ server }` (alongside your own HTTP routes), optionally mount config discovery via `exposeAuthConfig`, and run an opt-in WS keepalive via `heartbeatMs`; `createAuthConfigHandler` is the framework-agnostic primitive behind config discovery (see [docs/patterns/server-config-discovery.md](docs/patterns/server-config-discovery.md)).

Reference: [csbc-dev/arch (formerly hawc)](https://github.com/csbc-dev/arch/blob/main/README.md)

---

## 3. Layout of this project (`@csbc-dev/auth0`)

A headless Web Component package for handling Auth0 authentication declaratively. It is not a visual UI widget; it acts as an **I/O node** that connects Auth0 authentication to reactive state.

- **Input / command surface**: `domain`, `client-id`, `trigger`
- **Output state surface**: `authenticated`, `user`, `loading`, `error` (in remote mode, `connected` is added)
- **Token**: always excluded from the wcBindable surface for safety. In local mode it is read via `el.token` / `await el.getToken()`; in remote mode it is confined inside the Shell and is invisible to JS.

### Package exports (`package.json`)

| Export | Entry | Purpose |
|---|---|---|
| `.` | [src/index.ts](src/index.ts) | Browser-side main: `bootstrapAuth`, `AuthCore`, `AuthShell`, `Auth`, `AuthLogout`, `AuthSession`, `registerCoreDeclaration`, etc. |
| `./server` | [src/server/index.ts](src/server/index.ts) | Node server: `createAuthenticatedWSS` (supports `{ server }` attach, `exposeAuthConfig`, `heartbeatMs`), `handleConnection`, `verifyAuth0Token`, `extractTokenFromProtocol`, `createAuthConfigHandler`, `UserCore` |
| `./auto` | [src/auto/auto.min.js](src/auto/auto.min.js) | Standalone build that auto-registers when loaded via a script tag |

### Directory layout

```
src/
├── index.ts              Browser-facing barrel export
├── bootstrapAuth.ts      Entry point for component registration + initial config
├── registerComponents.ts Custom element registration logic
├── coreRegistry.ts       Named registration for Core declarations used in remote mode
├── config.ts             Overridable global settings such as tag names
├── autoTrigger.ts        Auto-launches login on URL callback detection
├── jwtPayload.ts         JWT decode / expiry helpers
├── protocolPrefix.ts     Constant for the WebSocket subprotocol prefix
├── raiseError.ts         Helper for dispatching error events
├── core/
│   └── AuthCore.ts       EventTarget Core that drives the Auth0 SDK (the decision-maker in local mode)
├── shell/
│   └── AuthShell.ts      HTMLElement Shell for <auth0-gate>; supports both local and remote modes
├── components/
│   ├── Auth.ts           Class that registers <auth0-gate> under the default tag name
│   ├── AuthLogout.ts     <auth0-logout> action element for logout buttons
│   └── AuthSession.ts    <auth0-session> readiness element collapsing authenticated→connected→initial-sync
├── server/               Node-side helpers (the @csbc-dev/auth0/server export)
└── auto/                 Standalone distribution for script-tag use (auto.js / auto.min.js)
```

### Component cheat sheet

| Element | Role | wcBindable outputs |
|---|---|---|
| `<auth0-gate>` | Authentication gatekeeper; covers both local and remote modes | `authenticated`, `user`, `loading`, `error` (remote also adds `connected`) |
| `<auth0-logout>` | Action element that triggers Auth0 logout on click | — |
| `<auth0-session>` | In remote mode, collapses the three-stage readiness (authenticated → WebSocket connection → initial sync) into a single `ready` | `ready` (plus intermediate state) |

### The two modes (recap, from this package's implementation perspective)

- **Local mode (default)**: `mode` is not specified and `remote-url` is unset or an empty string. The Auth0 SPA SDK runs in the browser. `getToken()` returns the token.
- **Remote mode**: triggered by `mode="remote"` or by a non-empty `remote-url`. The token only crosses the wire during the WebSocket handshake and during in-band `auth:refresh`. `token` is `null`, `getToken()` throws. Only the `exp` claim is exposed via `getTokenExpiry()`.

### Error contract

- Auth0 SDK failures (`initialize` / `login` / `logout` / `getToken`) **do not reject** — they publish to `error` / `auth0-gate:error` and clear `loading`. Consumers should bind the state, not wrap calls in `try/catch`.
- WebSocket I/O failures in remote mode (`connect` / `reconnect` / `refreshToken`) **do reject**. Wrap them when calling directly, or pick them up from `<auth0-session>`'s state.
- Precondition violations (missing `domain` / `client-id`, calling `getToken()` in remote mode, etc.) throw synchronously.
- `<auth0-session>`'s payload mirror (`_mirrorToPayload` / `_writePayloadMirror`) runs inside the `bind()` callback and **must never throw**. When the application has locked a mirrored property (`configurable: false`, seal / freeze, non-extensible), the mirror assigns the value if the property is still writable. Otherwise it writes nothing, does not re-dispatch the event, and skips the property with one `console.warn` per property per session. Do not "simplify" this to an unconditional `defineProperty`: a throw there leaves `ready` false or fails the whole session.
- `<auth0-session>` owns exactly the connection it got from `authEl.connect()`, including every `authEl.reconnect()` replacement of it. `AuthShell` keys each transport it hands out to a `ConnectionRecord` in the module-private `_connections` WeakMap. `connect()` starts a new record; `reconnect()` joins the record of the transport it replaces (captured before its first await) and moves `record.current` forward. `session.transport` resolves through the package-internal `currentAuthTransport()`. The session gives its connection back through the package-internal `releaseAuthTransport()` (`src/shell/AuthShell.ts`, not exported from the entry point) whenever the session ends:
  - `_teardown()`: logout / `authenticated=false`, transport loss, element removal or remount, `start()`.
  - A superseded `_connect()` that resumes while holding a transport.
  - `_connect()`'s failure path after the handshake: proxy construction, `bind()`'s initial sync, a command forwarder that cannot be installed.

  The release is identity-checked and does not bump `_connectGeneration`. So it never closes another owner's connection (Pattern B, a take-over `connect()`, or a `reconnect()` of either) and never cancels someone else's in-flight handshake. Do not "simplify" it to `disconnect()`, and do not go back to merely dropping the reference: an orphaned open WebSocket makes every remount / `start()` fail the Connection Ownership guard (SPEC-REMOTE §3.7).
  The identity check is against `record.current`. Do not key ownership back to the first transport only: a session whose connection was replaced by `reconnect()` would then orphan the replacement and fail the ownership guard on every `start()` / remount.
- A release while a `reconnect()` is replacing the connection marks `record.released` and returns `record.replacing` (a promise) instead of `true`.
  - `reconnect()` checks `released` after the token fetch and after `open`. It then closes its new socket (`"Superseded by connection release"`), publishes `connected=false`, and rejects.
  - `AuthSession._releaseConnection()` folds that promise into `_connectAttempt`, so the next `_connect()` waits for it as it does for its own superseded handshake.
  - Keep settling `replacing` in `reconnect()`'s `finally`, after `_connectInFlight = false`. Otherwise the waiting attempt resumes into the in-flight claim.
- The release runs after the session's own state is cleared and dispatches `connected-changed: false` synchronously. The session's `connected-changed` listener ignores that event while `_releasingConnection` is set. Keep that flag, or a newer attempt waiting for the release tears itself down.
- A teardown cannot cancel an in-flight handshake. The superseded attempt releases its transport when it resumes, and the next `_connect()` waits for it via `_connectAttempt`. Meanwhile it skips the `auth.connected` fast path; the atomic `failIfConnected` guard still applies. Without the wait, a remount / `start()` mid-handshake fails ownership against the session's own earlier attempt. In `_connect()`'s failure path, keep `_teardownProxy()` before `_setError()`: an `error` listener may synchronously call `start()` again.
- Command forwarders deliberately **fail** the session when a declared command name is locked on the payload (a non-configurable own property or a non-extensible element). The error carries `ERROR_PREFIX` and names the command, the lock and the fix. This is the intended opposite of the payload mirror's never-throw rule: a skipped forwarder would silently route the command to the application's member instead of the server. Do not "harmonize" the two.

### Primary development scripts

| Command | What it does |
|---|---|
| `npm run build` | Emits ESM + types into `dist/` via `tsc` (auto-run from `prepack`) |
| `npm run dev` | `tsc --watch` |
| `npm test` / `npm run test:unit` | `vitest run __tests__` |
| `npm run test:watch` | `vitest __tests__` |
| `npm run test:coverage` | Runs with V8 coverage (`src/types.ts`, `src/index.ts`, `src/server/index.ts`, `src/auto/**/*.d.ts` are excluded) |

The test environment uses `happy-dom` (see [vitest.config.ts](vitest.config.ts) and [__tests__/setup.ts](__tests__/setup.ts)). Unit tests (`authCore.test.ts` / `authShell.test.ts` and others), an E2E test (`e2e.test.ts`), and server-side tests (`__tests__/server/`) live under `__tests__/`.

### Dependency notes

- `@wc-bindable/core` (`^0.10.0`) — the wcBindable protocol implementation (runtime dependency)
- `static wcBindable` declarations are typed `IWcBindable`, which `extends` `@wc-bindable/core`'s `WcBindableDeclaration`, so they pass to `createRemoteCoreProxy()` / `registerCoreDeclaration()` without a cast. `IWcBindable` and its entry types are exported from both entry points.
  - Its lists are deliberately mutable arrays: upstream types them `T[]`, and a `readonly T[]` is not assignable to that.
  - Immutability comes from `freezeWcBindable()` (src/freezeWcBindable.ts), which deep-freezes every declaration. Do not "tighten" the lists back to `readonly` arrays, and wrap any new declaration in `freezeWcBindable()`.
  - `__tests__/wcBindableDeclarations.test.ts` guards both; its no-cast half runs only under `npm run typecheck`.
- `@wc-bindable/remote` (`^0.10.0`) — proxy used by remote mode, resolved from the npm registry like every other dependency (there is no `file:` / sibling-monorepo reference). 0.10 enforces a strict **JsonValue gate** on everything that crosses the wire (SPEC-REMOTE §5.0): `invoke` arguments that are not JSON (`undefined`, `Date`, class instances, DOM `Event`s) reject with `WC_BINDABLE_INVALID_JSON_VALUE`, non-JSON command return values with `WC_BINDABLE_INVALID_RETURN_VALUE`, and a non-JSON property value — **including an object with a field whose value is `undefined`** — is silently dropped by `RemoteShellProxy`. That is why `UserCore.currentUser` omits absent `email` / `name` keys instead of setting them to `undefined`; do not "simplify" it back to an object literal. Forwarders installed by `<auth0-session>` pass their arguments through unchanged, so never wire a DOM event straight to one (README-REMOTE "Wire values must be JSON").
- `jose` — JWT verification / decoding
- `@auth0/auth0-spa-js` / `ws` — **peerDependencies (optional)**. The former is required only by local mode and the latter only by the server / remote side, so consumers install whichever matches their mode

### Reference docs

- [README.md](README.md) — package overview and mode-selection criteria
- [README-LOCAL.md](README-LOCAL.md) — using local mode
- [README-REMOTE.md](README-REMOTE.md) — using remote mode
- [SPEC-REMOTE.md](SPEC-REMOTE.md) — remote protocol spec, server handler, error codes, threat model
