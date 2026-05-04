import { WebSocketClientTransport } from "@wc-bindable/remote";
import type { ClientTransport, ClientMessage, ServerMessage } from "@wc-bindable/remote";
import { AuthCore } from "../core/AuthCore.js";
import { raiseError, raiseOwnershipError, ERROR_PREFIX } from "../raiseError.js";
import { IWcBindable, AuthMode, AuthShellOptions, AuthError, AuthUser } from "../types.js";
import { PROTOCOL_PREFIX } from "../protocolPrefix.js";

let _nextRefreshId = 1;
type RefreshResponseMessage = Extract<ServerMessage, { type: "return" | "throw" }>;

/**
 * Default OAuth scope requested when none is supplied.
 *
 * Centralised so `AuthShell.initialize()` and `<auth0-gate>.scope`'s
 * attribute getter cannot drift out of sync. `openid profile email`
 * is the conventional Auth0 default — `openid` is required for any
 * OIDC flow, `profile` / `email` populate `AuthUser.name` / `email`
 * which the `auth0-gate:user-changed` consumers depend on.
 */
export const DEFAULT_SCOPE = "openid profile email";

/**
 * Remote-capable authentication shell.
 *
 * Wraps AuthCore (which handles Auth0 SPA SDK interaction) and adds
 * WebSocket connection management for the remote CSBC architecture.
 *
 * AuthShell deliberately does NOT expose `token` in its wcBindable
 * declaration. The token is used internally only during the WebSocket
 * handshake, minimising XSS exposure surface.
 */
export class AuthShell extends EventTarget {
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "authenticated", event: "auth0-gate:authenticated-changed" },
      { name: "user",          event: "auth0-gate:user-changed" },
      { name: "loading",       event: "auth0-gate:loading-changed" },
      { name: "error",         event: "auth0-gate:error" },
      { name: "connected",     event: "auth0-gate:connected-changed" },
    ],
  };

  private _core: AuthCore;
  // Dispatch target for AuthShell-originated events (currently only
  // `auth0-gate:connected-changed`). Mirrors the target passed to
  // AuthCore so that ALL auth0-gate:* events fire on the same element —
  // typically the `<auth0-gate>` Auth element that wraps this shell.
  // Without this, `connected-changed` uniquely fired on the AuthShell
  // instance itself while authenticated-changed / user-changed /
  // loading-changed / error / token-changed all fired on Auth, making
  // AuthSession's `connected-changed` listener on the Auth element a
  // silent no-op (K-001).
  private _target: EventTarget;
  private _connected: boolean = false;
  private _ws: WebSocket | null = null;
  private _transport: InterceptingClientTransport | null = null;
  private _url: string = "";
  private _mode: AuthMode = "local";
  // Audience passed to initialize(). Cached so connect() / reconnect()
  // can fail fast in remote mode when it's missing — the server's
  // verifyAuth0Token enforces an `aud` match and would otherwise close
  // the just-opened socket with 1008, leaving the failure to surface
  // through the WebSocket close path far from the originating call.
  private _audience: string | undefined;
  // Synchronous in-flight claim used by the atomic `failIfConnected`
  // ownership guard in `connect()`. Flipped to `true` BEFORE the first
  // `await` and reset in `finally`, so concurrent callers — including
  // the race across `Auth.connect()`'s `await connectedCallbackPromise`
  // microtask — observe an existing handshake synchronously.
  private _connectInFlight: boolean = false;
  // Monotonic generation counter incremented on every `disconnect()` /
  // `logout()`. Each `connect()` / `reconnect()` captures the current
  // value at entry and re-checks it after every `await`; if the
  // counter has moved forward by the time the handshake resolves, the
  // freshly-opened socket is closed and the call rejects so a pending
  // connect cannot resolve to `connected=true` AFTER the user already
  // logged out (with the token already invalidated). Without this,
  // `disconnect()` / `logout()` would tear down the transport but a
  // racing `connect()` could re-set `connected=true` one microtask later.
  private _connectGeneration: number = 0;

  constructor(target?: EventTarget) {
    super();
    // AuthCore dispatches events on the provided target, so passing `this`
    // means authenticated/user/loading/error events fire on the AuthShell.
    // Cache the SAME target for `_setConnected`'s `connected-changed`
    // dispatch — if we dispatched on `this` instead, the event would
    // land on the AuthShell and never reach the outer Auth element that
    // AuthSession (and any application listener) registered against.
    const outer = target ?? this;
    this._target = outer;

    // Build a private relay EventTarget that AuthCore dispatches into,
    // and re-fire each `auth0-gate:*` event onto `outer` — EXCEPT
    // `auth0-gate:token-changed` while in remote mode.
    //
    // Why this filter exists:
    //   `AuthShell.wcBindable` deliberately excludes `token` so the
    //   declarative binding surface (`data-wcs="..."`) cannot subscribe
    //   to it in remote mode. But the underlying `auth0-gate:token-changed`
    //   CustomEvent — dispatched by AuthCore via `_target.dispatchEvent`
    //   — was previously firing directly on the Auth element with the
    //   bearer in `event.detail`. Any application code listening
    //   imperatively (`authEl.addEventListener("auth0-gate:token-changed",
    //   ...)`) or any third-party DOM observer would receive the token
    //   on every commit, defeating the remote-mode "token never reachable
    //   from JS" contract (see CLAUDE.md §3 — Token visibility).
    //
    //   The relay routes AuthCore's events through us; for token-changed
    //   in remote mode we DROP the re-dispatch entirely, so DOM
    //   listeners on the Auth element observe nothing. Local-mode
    //   token-changed still fires on `outer` so existing local-mode
    //   subscribers are unaffected.
    //
    //   AuthCore itself remains a discoverable EventTarget for
    //   in-process consumers (unit tests, advanced direct-Core
    //   embedders) that listen on the AuthCore instance — the wcBindable
    //   "token in AuthCore is intentional, scope-limited" carve-out in
    //   AuthCore.ts is preserved.
    const relay = new EventTarget();
    const FORWARDED_EVENT_NAMES = [
      "auth0-gate:authenticated-changed",
      "auth0-gate:user-changed",
      "auth0-gate:loading-changed",
      "auth0-gate:error",
      "auth0-gate:token-changed",
    ] as const;
    for (const name of FORWARDED_EVENT_NAMES) {
      relay.addEventListener(name, (e) => {
        if (name === "auth0-gate:token-changed" && this._mode === "remote") {
          return;
        }
        const ce = e as CustomEvent;
        outer.dispatchEvent(new CustomEvent(name, {
          detail: ce.detail,
          bubbles: true,
        }));
      });
    }
    this._core = new AuthCore(relay);
  }

  // --- Delegated getters ---------------------------------------------------

  get authenticated(): boolean {
    return this._core.authenticated;
  }

  get user(): AuthUser | null {
    return this._core.user;
  }

  get loading(): boolean {
    return this._core.loading;
  }

  get error(): AuthError | Error | null {
    return this._core.error;
  }

  get connected(): boolean {
    return this._connected;
  }

  /**
   * Raw Auth0 client — exposed for advanced use only.
   *
   * Typed as `unknown` rather than `any` so consumers cannot
   * accidentally silently rely on the `@auth0/auth0-spa-js` surface
   * (which is a *peer* dependency of this package, not a runtime dep).
   * Callers that need the concrete `Auth0Client` interface should
   * `import type { Auth0Client } from "@auth0/auth0-spa-js"` themselves
   * and narrow via `as Auth0Client`.
   */
  get client(): unknown {
    return this._core.client;
  }

  /** Deployment mode. See {@link AuthMode}. */
  get mode(): AuthMode {
    return this._mode;
  }

  set mode(value: AuthMode) {
    // No synchronous audience validation here: the `<auth0-gate>`
    // element pattern mirrors `mode` from its attribute during the
    // element lifecycle (connectedCallback / attributeChangedCallback)
    // BEFORE `initialize()` plumbs `_audience` into the shell. A
    // strict setter-level validation would therefore reject every
    // legal `<auth0-gate mode="remote" audience="...">` mount and
    // every `attributeChangedCallback` mirror that runs against a
    // shell whose audience has not yet been initialised.
    //
    // Audience enforcement happens at `connect()` / `reconnect()` —
    // the only places the missing-audience misconfiguration is
    // actually observable on the wire (server's verifyAuth0Token
    // rejects on `aud` mismatch and closes with 1008). Catching it
    // there keeps the precondition next to the wire interaction.
    //
    // On an actual mode change, bump `_connectGeneration` so any
    // in-flight `connect()` / `reconnect()` started under the old
    // mode sees the mismatch on its next `await` boundary and bails
    // — without this, a mid-flight handshake from before the flip
    // could resolve and commit `connected=true` for a session whose
    // mode (and therefore the remote-vs-local token contract) has
    // since changed under it. The attribute mirror in
    // `Auth.attributeChangedCallback` writes the same value
    // repeatedly, so guard on actual change to avoid bumping the
    // generation on no-op writes (which would tear down legitimate
    // in-flight handshakes started by the same attribute landing).
    if (this._mode === value) return;
    this._mode = value;
    this._connectGeneration++;
  }

  /**
   * Access token.
   *
   * In `"local"` mode: returns the current access token (or `null`) so
   * application code can attach `Authorization: Bearer` headers.
   *
   * In `"remote"` mode: always returns `null`. The token is held inside
   * AuthShell and sent on the wire only at the WebSocket handshake and
   * during in-band `auth:refresh`; application code must not read or
   * forward it.
   *
   * Never part of the wcBindable surface (by design).
   */
  get token(): string | null {
    if (this._mode === "remote") return null;
    return this._core.token;
  }

  get initPromise(): Promise<void> | null {
    return this._core.initPromise;
  }

  /**
   * Current access token's expiry as a millisecond epoch, or `null`
   * if no token is held. Does NOT expose the token material —
   * intended for refresh schedulers in remote deployments where
   * `token` is deliberately kept inside AuthShell.
   */
  getTokenExpiry(): number | null {
    return this._core.getTokenExpiry();
  }

  // --- Lifecycle ------------------------------------------------------------

  /**
   * Initialise the Auth0 client. Converts AuthShellOptions into the
   * Auth0ClientOptions that AuthCore expects.
   *
   * `_mode` / `_audience` are published BEFORE delegating to
   * `_core.initialize()` so that the rest of this method — and any
   * listener awaiting `initPromise` — reads consistent state. If
   * `_core.initialize()` throws synchronously (e.g. missing `domain`
   * / `clientId` -> `raiseError`), we roll those writes back to the
   * values they held on entry. Otherwise a hot-reload / test helper
   * that calls `initialize()` with deliberately-bad options and then
   * retries with good ones would see the bad-attempt's `_mode` /
   * `_audience` leak into the retry, with the retry silently
   * pass-through on a stale `audience` check in `connect()`.
   */
  initialize(options: AuthShellOptions): Promise<void> {
    const prevMode = this._mode;
    const prevAudience = this._audience;
    this._mode = options.mode ?? "local";
    this._audience = options.audience || undefined;

    const authorizationParams: Record<string, any> = {
      scope: options.scope ?? DEFAULT_SCOPE,
    };
    if (options.redirectUri) {
      authorizationParams.redirect_uri = options.redirectUri;
    }
    if (options.audience) {
      authorizationParams.audience = options.audience;
    }

    try {
      return this._core.initialize({
        domain: options.domain,
        clientId: options.clientId,
        authorizationParams,
        cacheLocation: options.cacheLocation,
        useRefreshTokens: options.useRefreshTokens ?? true,
      });
    } catch (err) {
      // Synchronous `raiseError` from AuthCore.initialize (missing
      // domain / clientId). Async rejections don't land here — they
      // flow through the returned Promise — so post-init async
      // failures deliberately keep the accepted `_mode` / `_audience`.
      this._mode = prevMode;
      this._audience = prevAudience;
      throw err;
    }
  }

  async login(options?: Record<string, any>): Promise<void> {
    return this._core.login(options);
  }

  async loginWithPopup(options?: Record<string, any>): Promise<void> {
    return this._core.loginWithPopup(options);
  }

  async logout(options?: Record<string, any>): Promise<void> {
    // `_closeWebSocket()` severs the transport but does NOT fire
    // `connected-changed` — the WebSocket's async close handler would
    // get there, but only after its event loop tick, which is too late
    // for subscribers that gate logout UX on `connected=false`. The
    // explicit `_setConnected(false)` here publishes the transition
    // synchronously; the inner equality guard prevents a duplicate
    // event if the socket's close handler beat us to it.
    //
    // Bump the connect generation so any pending `connect()` /
    // `reconnect()` whose handshake has already opened (or is awaiting
    // open) cannot resume past its post-await guard and re-set
    // `connected=true` after we've torn down the session. The token has
    // been invalidated by Auth0; resolving the racing connect would
    // leave the application advertising `connected` against a server
    // that no longer honours the bearer.
    this._connectGeneration++;
    this._closeWebSocket();
    this._setConnected(false);
    return this._core.logout(options);
  }

  /**
   * Close the authenticated WebSocket without logging out of Auth0.
   *
   * Used by `<auth0-gate>`'s `disconnectedCallback` so that removing
   * the element from the DOM (SPA route change, conditional render)
   * releases the server-side session instead of leaking an ownerless
   * authenticated connection. Also callable imperatively when an
   * application wants to drop the remote session while keeping the
   * user signed in for a future reconnect.
   *
   * Idempotent when no connection is open.
   */
  disconnect(): void {
    // Bump the connect generation so a pending `connect()` /
    // `reconnect()` whose `await new Promise(open|error)` is still
    // pending (or has just resolved) sees the mismatch and bails
    // before flipping `connected=true`. Without this bump, a
    // disconnect that lands between the WebSocket `open` event and
    // the connect()'s `_setConnected(true)` would still see the
    // racing connect publish `connected=true` post-disconnect.
    this._connectGeneration++;
    this._closeWebSocket();
    this._setConnected(false);
  }

  async getToken(options?: Record<string, any>): Promise<string | null> {
    if (this._mode === "remote") {
      raiseError(
        "getToken() is disabled in remote mode. The access token stays inside AuthShell; use the WebSocket transport for authenticated calls and getTokenExpiry() for refresh scheduling.",
      );
    }
    return this._core.getToken(options);
  }

  // --- Remote connection ----------------------------------------------------

  /**
   * Establish an authenticated WebSocket connection.
   *
   * The access token is sent in the `Sec-WebSocket-Protocol` header as
   * `auth0-gate.bearer.{JWT}`. Returns a `ClientTransport` that can be
   * passed to `createRemoteCoreProxy()`.
   *
   * `options.failIfConnected` opts into an atomic ownership guard: the
   * call rejects fast when another connection is open OR another
   * handshake is already in flight, instead of silently closing the
   * other party's socket via `_closeWebSocket()`. `<auth0-session>`
   * passes this flag to stop a race between its synchronous
   * `auth.connected` check and the subsequent `await auth.connect()`
   * microtask hop (SPEC-REMOTE §3.7 — Connection Ownership).
   * Direct callers that explicitly want to take over an existing
   * transport omit the flag and fall back to the legacy
   * `_closeWebSocket()`-then-reconnect behaviour.
   *
   * **WARNING — concurrent connect() without `failIfConnected`:**
   *
   * `connect()` and `reconnect()` are intentionally asymmetric here.
   * `reconnect()` ALWAYS checks `_connectInFlight` and rejects on
   * concurrent entry; `connect()` only checks when
   * `failIfConnected: true` is explicitly passed. Without the flag,
   * two concurrent `connect()` callers both pass the (skipped) guard,
   * both flip `_connectInFlight = true`, both `await fetchToken()`,
   * both `_closeWebSocket()`, and both open a new socket — only the
   * second's reference survives in `_ws`, leaving the first caller
   * with a returned transport bound to a socket that the second
   * caller's `_closeWebSocket()` already closed. SPEC-REMOTE §3.7
   * documents this as "last writer wins"; the actual contract for
   * direct callers is "concurrent connect() without `failIfConnected`
   * is undefined behaviour — the returned transports may be dead and
   * the first caller's `_token` rollback may collide with the
   * second's commit". Pass `failIfConnected: true` to opt into the
   * atomic guard, or serialise calls externally if your application
   * truly needs the legacy take-over semantics.
   *
   * `<auth0-session>` always passes `failIfConnected: true`, so the
   * declarative path is safe by construction; the warning applies
   * only to applications that call `authEl.connect()` imperatively
   * from multiple call sites.
   */
  async connect(
    url: string,
    options?: { failIfConnected?: boolean },
  ): Promise<ClientTransport> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }
    if (!url) {
      raiseError(
        "connect(): WebSocket URL is required. Pass it as the argument or set the `remote-url` attribute on <auth0-gate>.",
      );
    }
    // Remote mode without `audience` is unrecoverable on the wire:
    // verifyAuth0Token rejects the handshake on `aud` mismatch and the
    // server closes with 1008. Without this precondition, the failure
    // would only surface through the close handler — long after the
    // call site, and via a generic "WebSocket connection failed"
    // message that points at the URL instead of the missing attribute.
    // Throwing here keeps the diagnostic next to the configuration
    // mistake (see README-REMOTE.md §State Surface — `audience`).
    if (this._mode === "remote" && !this._audience) {
      raiseError(
        "connect(): `audience` is required in remote mode. " +
        "Set the `audience` attribute on <auth0-gate> to your API identifier — " +
        "without it the server's verifyAuth0Token rejects the handshake on `aud` mismatch.",
      );
    }

    // Atomic ownership claim. Both the existence check and the flag
    // toggle run BEFORE the first await, so a concurrent caller crossing
    // `Auth.connect()`'s `await connectedCallbackPromise` boundary
    // observes `_connectInFlight` and bails out instead of racing into
    // `_closeWebSocket()` and tearing down the first owner's socket.
    if (
      options?.failIfConnected &&
      (this._connectInFlight || this._ws !== null || this._connected)
    ) {
      raiseOwnershipError(
        "connect(): target already owns a connection or a handshake is in flight. " +
        "Another path (<auth0-session>, direct authEl.connect(), or an in-flight call) " +
        "is managing the transport — see SPEC-REMOTE §3.7 (Connection Ownership).",
      );
    }
    this._connectInFlight = true;
    // Capture the generation BEFORE the first await so a concurrent
    // `disconnect()` / `logout()` that bumps the counter while we're
    // mid-handshake is observable on resume. Re-checked after the
    // open/error promise — if it's stale, we close the just-opened
    // socket and reject without ever flipping `connected=true`.
    const myGeneration = this._connectGeneration;

    try {
      // Fetch-then-commit: same invariant as refreshToken / reconnect.
      // The token is published to AuthCore only after the server accepts
      // it via the WebSocket handshake (`open`). If the initial connection
      // fails, `_token` and `getTokenExpiry()` stay aligned with the last
      // server-accepted state (typically null on first attempt).
      const token = await this._core.fetchToken();
      if (!token) {
        raiseError("Failed to obtain access token.");
      }
      // A `disconnect()` / `logout()` that landed during fetchToken()
      // means the token we just obtained is destined for a session the
      // caller has already torn down. Bail before opening a socket so
      // we don't even hand a token to the wire post-logout.
      if (this._connectGeneration !== myGeneration) {
        raiseError("connect(): superseded by disconnect()/logout() during token fetch.");
      }

      // Capture the last server-accepted token BEFORE we close the
      // previous socket / open a new one. If the new token ends up being
      // rejected by the server (verification runs async AFTER the 101
      // handshake — see close handler below), we roll `_token` back to
      // this value so `getTokenExpiry()` and `token-changed` subscribers
      // never advertise a token the server never accepted.
      //
      // Limitation under concurrent connect() without `failIfConnected`:
      // two callers that race through `fetchToken()` observe the same
      // `_core.token` here, so the later caller's `priorToken` captures
      // the pre-race value rather than the first caller's just-committed
      // token. The spec (SPEC-REMOTE §3.7) already warns "last writer
      // wins" in that configuration — applications that care about
      // strict rollback ordering must opt into `failIfConnected: true`,
      // which short-circuits the race at the ownership guard.
      const priorToken = this._core.token;
      // Capture the previous URL so a handshake failure can roll
      // `_url` back: writing it BEFORE the open event would leave a
      // bad URL cached for a subsequent `reconnect()`, which uses
      // `_url` verbatim. The mid-call write is required so the
      // close-handler / debugging surface sees the URL we are
      // attempting; restoring it on failure is the symmetrical step.
      const priorUrl = this._url;

      this._closeWebSocket();

      this._url = url;
      const ws = new WebSocket(url, [`${PROTOCOL_PREFIX}${token}`]);
      this._ws = ws;

      // Pass the about-to-be-committed `token` as `committedToken` so
      // the close handler skips its rollback when a later
      // `refreshToken()` has overwritten `_core.token` with a fresher
      // value — the rollback fires only when `_core.token` is still
      // exactly what THIS handshake committed.
      this._installCloseHandler(ws, priorToken, token);

      // Wait for the connection to open before returning the transport.
      // If the handshake fails we MUST drop `connected` back to false:
      // _closeWebSocket() above nulled `_ws` before close()-ing the
      // previous socket, so the previous socket's close handler became
      // a no-op (its `this._ws === ws` guard fails), and without this
      // explicit clear `connected` would stay true even though no live
      // transport remains. This corrupts any UI / retry logic keyed off
      // `connected`. Also null the failed socket reference so `_ws` does
      // not linger as a dangling reference to a dead socket between calls.
      try {
        await new Promise<void>((resolve, reject) => {
          // Cross-remove handlers when the race resolves so the loser's
          // closure (and the captured `reject` / `resolve`) is released
          // immediately. `{ once: true }` fires only when the matching
          // event actually arrives — the unfired listener stays
          // attached for the lifetime of the socket otherwise, holding
          // this Promise's `reject` reachable and producing a slow leak
          // in a long-lived authenticated app that opens / closes
          // sockets across reconnects.
          const onOpen = (): void => {
            ws.removeEventListener("error", onError);
            resolve();
          };
          const onError = (): void => {
            ws.removeEventListener("open", onOpen);
            reject(new Error(`${ERROR_PREFIX} WebSocket connection failed: ${url}`));
          };
          ws.addEventListener("open", onOpen, { once: true });
          ws.addEventListener("error", onError, { once: true });
        });
      } catch (err) {
        if (this._ws === ws) {
          this._ws = null;
        }
        // Roll `_url` back so a subsequent `reconnect()` does not
        // reuse the failed URL — `reconnect()` reads `_url` verbatim
        // and would otherwise repeat the same DNS / TLS / handshake
        // failure mode against a URL the caller may have already
        // identified as bad.
        this._url = priorUrl;
        this._setConnected(false);
        throw err;
      }

      // A `disconnect()` / `logout()` that fired between the WebSocket
      // `open` and this resume point invalidates the session we were
      // building. Close the freshly-opened socket synchronously and
      // reject so `connected` cannot be flipped to `true` AFTER the
      // caller already tore down — the token is by now invalidated
      // (logout case) or the caller no longer wants the connection
      // (disconnect case). Without this guard, the caller's
      // `await connect()` would resolve to a transport tied to a
      // server-side session that the logout has just dropped.
      if (this._connectGeneration !== myGeneration) {
        if (this._ws === ws) {
          this._ws = null;
        }
        try {
          ws.close(1000, "Superseded by disconnect/logout");
        } catch {
          // see _closeWebSocket() — alternative runtimes may throw
        }
        // Same `_url` rollback rationale as the handshake-failure
        // path above — a superseded connect should not poison
        // `reconnect()` with the to-be-discarded URL.
        this._url = priorUrl;
        raiseError("connect(): superseded by disconnect()/logout() during handshake.");
      }

      // 101 handshake completed — commit provisionally. Auth0 token
      // verification on the server runs AFTER the upgrade response, so
      // `open` is NOT proof of server acceptance. The close handler
      // above rolls `_token` back if the server closes without ever
      // sending a frame (its unauthorized-rejection path).
      this._core.commitToken(token);
      this._setConnected(true);
      return this._createTransport(ws);
    } finally {
      // Always release the ownership claim, whether we succeeded,
      // threw from a precondition, or rejected at handshake.
      this._connectInFlight = false;
    }
  }

  /**
   * In-band token refresh (Strategy A — §3.4.1).
   *
   * Obtains a fresh access token from Auth0 and sends it to the server
   * over the **existing** WebSocket as an `auth:refresh` command.
   * The server re-verifies the token and updates the session expiry
   * without reconstructing Cores — Core state is fully continuous.
   *
  * Sends directly on the raw WebSocket, but registers a one-shot
  * response interceptor on the returned ClientTransport so the
  * matching `return` / `throw` frame is consumed before downstream
  * consumers such as RemoteCoreProxy see it.
   */
  async refreshToken(): Promise<void> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }
    if (!this._ws || this._ws.readyState !== WebSocket.OPEN) {
      raiseError("No active connection. Call connect() first.");
    }

    // Fetch the new token WITHOUT committing it. We only publish it
    // into AuthCore once the server has confirmed acceptance, otherwise
    // `getTokenExpiry()` would advance ahead of the session the server
    // is actually enforcing, and exp-based schedulers would delay the
    // next refresh past the server-side deadline.
    const token = await this._core.fetchFreshToken();
    if (!token) {
      raiseError("Failed to refresh access token.");
    }

    // Use a package-namespaced prefix so a generated refresh id cannot
    // collide with a `RemoteShellProxy`-issued command id (its scheme
    // is integer-based and bare). The `__auth0-gate.refresh.` prefix is
    // long and dotted enough that no realistic id-generation strategy
    // in the wc-bindable/remote ecosystem will produce a duplicate.
    const id = `__auth0-gate.refresh.${_nextRefreshId++}`;
    const ws = this._ws;
    const transport = this._transport;
    // The `raiseError(...): never` return type lets TypeScript narrow
    // `transport` to `InterceptingClientTransport` (non-null) on every
    // subsequent use inside this method — without that narrowing we'd
    // have to either non-null-assert (`transport!`) or introduce a
    // local `assertDefined(transport)` helper. Keeping the guard here
    // preserves the invariant check AND the narrowing in one step;
    // changing `raiseError` to return `void` would break this.
    if (!transport) {
      raiseError("No active connection. Call connect() first.");
    }

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      let releaseIntercept: (() => void) | undefined;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        releaseIntercept?.();
        ws.removeEventListener("close", onClose);
        ws.removeEventListener("error", onError);
      };

      const onMessage = (msg: RefreshResponseMessage) => {
        cleanup();
        if (msg.type === "return") resolve();
        else reject(new Error(_getErrorMessage(msg.error)));
      };

      const onClose = () => {
        cleanup();
        reject(new Error("WebSocket closed before token refresh completed"));
      };

      const onError = () => {
        cleanup();
        reject(new Error("WebSocket error during token refresh"));
      };

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("Token refresh timed out"));
      }, 30_000);

      releaseIntercept = transport.interceptResponse(id, onMessage);
      ws.addEventListener("close", onClose, { once: true });
      ws.addEventListener("error", onError, { once: true });
      try {
        transport.send({
          type: "cmd",
          name: "auth:refresh",
          id,
          args: [token],
        });
      } catch (sendErr) {
        // ws.send can throw synchronously if the socket transitioned out
        // of OPEN between the readyState check and this call. Without an
        // explicit cleanup the 30-second timer, response interceptor, and
        // close/error listeners would survive, leaking an unhandled rejection
        // at timeout and risking misattribution of unrelated future frames.
        cleanup();
        reject(sendErr instanceof Error ? sendErr : new Error(String(sendErr)));
      }
    });

    // Server has returned success — safe to publish the new token.
    this._core.commitToken(token);
  }

  /**
   * Refresh the token and establish a new WebSocket connection
   * (Strategy B — §3.4.2, fallback for crash recovery).
   *
   * Returns a new `ClientTransport`. Use with `proxy.reconnect(transport)`
   * to swap the underlying connection. Note: server-side Core state is
   * rebuilt from scratch — property values may change.
   *
   * Shares the `_connectInFlight` ownership claim with `connect()`:
   * a concurrent `reconnect()` / `connect({ failIfConnected: true })`
   * fails fast instead of racing two `_closeWebSocket()` + handshake
   * pairs. Without this, a second reconnect call would close the
   * first reconnect's in-flight socket, leaving the first caller with
   * a broken transport while `_ws` pointed at the second's socket.
   */
  async reconnect(): Promise<ClientTransport> {
    if (!this._core.client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }
    if (!this._url) {
      raiseError("No previous connection URL. Call connect() first.");
    }
    // Mirror connect(): a remote-mode reconnect without audience is
    // rejected by the server on `aud` mismatch — fail fast at the
    // call site instead of waiting for the 1008 close to surface.
    if (this._mode === "remote" && !this._audience) {
      raiseError(
        "reconnect(): `audience` is required in remote mode. " +
        "Set the `audience` attribute on <auth0-gate> to your API identifier — " +
        "without it the server's verifyAuth0Token rejects the handshake on `aud` mismatch.",
      );
    }

    // Atomic ownership claim shared with connect(). Set BEFORE any
    // await so a concurrent connect() / reconnect() observes it
    // synchronously. A parallel reconnect bails out with the same
    // ownership error as a racing connect(failIfConnected), and the
    // first caller proceeds to completion without being torn down.
    if (this._connectInFlight) {
      raiseOwnershipError(
        "reconnect(): another handshake (connect or reconnect) is already in flight. " +
        "See SPEC-REMOTE §3.7 (Connection Ownership).",
      );
    }
    this._connectInFlight = true;
    // See connect(): capture the generation BEFORE the first await
    // so a concurrent `disconnect()` / `logout()` that bumps the
    // counter while we're mid-handshake is observable on resume.
    const myGeneration = this._connectGeneration;

    try {
      // Fetch-then-commit: the new token is published to AuthCore only
      // after the server accepts it via the WebSocket handshake (`open`).
      // If the reconnection fails, `_token` and `getTokenExpiry()` stay
      // aligned with the last session the server actually honoured.
      const token = await this._core.fetchFreshToken();
      if (!token) {
        raiseError("Failed to refresh access token.");
      }
      if (this._connectGeneration !== myGeneration) {
        raiseError("reconnect(): superseded by disconnect()/logout() during token fetch.");
      }

      // See connect(): capture the last server-accepted token so we can
      // roll `_token` back if the server rejects this reconnection's
      // token (verification is async, happens AFTER `open`).
      const priorToken = this._core.token;

      this._closeWebSocket();

      const ws = new WebSocket(this._url, [`${PROTOCOL_PREFIX}${token}`]);
      this._ws = ws;

      // See connect(): pass the about-to-be-committed `token` so the
      // close handler skips its rollback when a later `refreshToken()`
      // has overwritten `_core.token` with a fresher value.
      this._installCloseHandler(ws, priorToken, token);

      // See connect(): the previous socket's close handler is now a no-op,
      // so a handshake failure here would leave `connected` stuck at true
      // unless we explicitly clear it on the failure path. Also null the
      // failed socket reference so `_ws` does not linger as a dangling
      // reference to a dead socket between calls.
      try {
        await new Promise<void>((resolve, reject) => {
          // Mirror connect(): cross-remove the loser of the open/error
          // race so its closure does not stay reachable through the
          // socket's listener list for the whole lifetime of the
          // connection. See connect()'s open/error promise for the
          // detailed rationale.
          const onOpen = (): void => {
            ws.removeEventListener("error", onError);
            resolve();
          };
          const onError = (): void => {
            ws.removeEventListener("open", onOpen);
            reject(new Error(`${ERROR_PREFIX} WebSocket reconnection failed: ${this._url}`));
          };
          ws.addEventListener("open", onOpen, { once: true });
          ws.addEventListener("error", onError, { once: true });
        });
      } catch (err) {
        if (this._ws === ws) {
          this._ws = null;
        }
        this._setConnected(false);
        throw err;
      }

      // See connect(): a `disconnect()` / `logout()` that fired
      // between WebSocket `open` and this resume point invalidates the
      // session we just opened. Close the freshly-opened socket
      // synchronously and reject so `connected` cannot be flipped to
      // `true` AFTER teardown.
      if (this._connectGeneration !== myGeneration) {
        if (this._ws === ws) {
          this._ws = null;
        }
        try {
          ws.close(1000, "Superseded by disconnect/logout");
        } catch {
          // see _closeWebSocket() — alternative runtimes may throw
        }
        raiseError("reconnect(): superseded by disconnect()/logout() during handshake.");
      }

      // 101 handshake completed — commit provisionally. See connect():
      // Auth0 verification on the server runs AFTER the upgrade, so
      // a later unauthorized close triggers the close handler's
      // rollback of `_token` to the prior server-accepted value.
      this._core.commitToken(token);
      this._setConnected(true);
      return this._createTransport(ws);
    } finally {
      // Always release the ownership claim so the next connect /
      // reconnect can proceed (including post-failure retries).
      this._connectInFlight = false;
    }
  }

  // --- Private helpers ------------------------------------------------------

  /**
   * Install the shared close handler used by both `connect()` and
   * `reconnect()`. Both paths need identical behaviour on close:
   *
   *   1. Null `_ws` only when this socket is still the live one — a
   *      newer socket installed by a re-entrant connect/reconnect
   *      must not be stomped (`_ws === ws` guard).
   *   2. Publish `connected=false` synchronously so the
   *      `failIfConnected: true` ownership guard (`_ws !== null ||
   *      _connected`) cannot reject subsequent reconnects against a
   *      dead socket.
   *   3. Roll `_token` back to the last server-accepted value ONLY
   *      on close code 1008 — `createAuthenticatedWSS` emits 1008
   *      strictly on the pre-accept paths (`socket.close(1008,
   *      "Unauthorized" | "Forbidden origin")`). Post-accept closes
   *      (4401 expired, 4403 sub mismatch, 1000 normal, 1006
   *      abnormal) leave the committed token in place, because the
   *      session WAS accepted at some point and a "first inbound
   *      frame" rollback signal would spuriously roll back valid
   *      sessions that simply never sent a frame.
   *
   * Extracting the handler keeps the two construction paths in lock
   * step — drift between them would silently bias one path's
   * rollback semantics relative to the other.
   *
   * `committedToken` — the token THIS handshake just committed —
   * is passed alongside `priorToken` so the rollback can be skipped
   * when a subsequent `refreshToken()` has overwritten `_core.token`
   * with a fresher value: rolling back to `priorToken` in that case
   * would clobber the fresh refresh with a stale connect-time
   * snapshot. The reference server only emits 1008 pre-accept per
   * SPEC-REMOTE, so the post-accept-then-1008 path is only reachable
   * against a non-conformant server, but the guard is cheap.
   */
  private _installCloseHandler(
    ws: WebSocket,
    priorToken: string | null,
    committedToken: string | null,
  ): void {
    ws.addEventListener("close", (event: CloseEvent) => {
      if (this._ws !== ws) return;
      this._ws = null;
      this._setConnected(false);
      if (
        event?.code === 1008 &&
        this._core.token === committedToken &&
        this._core.token !== priorToken
      ) {
        this._core.commitToken(priorToken);
      }
    });
  }

  private _setConnected(value: boolean): void {
    if (this._connected === value) return;
    this._connected = value;
    // Dispatch on `_target` (Auth element or the shell itself if no
    // target was provided). Prior to K-001 this fired on `this`, so the
    // event was stranded on the AuthShell instance and never reached
    // AuthSession's listener, which registers on the Auth element and
    // needs this event to tear down on transport loss (4401/4403/1008/
    // 1006 close codes, network failure, server restart). Without the
    // target-consistent dispatch, AuthSession would linger in
    // `ready=true` pointing at a dead socket and the next proxy call
    // would reject with `_disposedError`.
    this._target.dispatchEvent(new CustomEvent("auth0-gate:connected-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  /**
   * Close the underlying WebSocket (if any) and dispose of the
   * cached InterceptingClientTransport.
   *
   * Invariants observed by callers (logout, disconnect, connect /
   * reconnect re-entry):
   *   - `_ws` is nulled BEFORE `ws.close()` so the old socket's
   *     async `close` handler observes `this._ws !== ws` and becomes
   *     a no-op. Without this, the old close handler would stomp on
   *     a newer socket that has already replaced it (via the
   *     `_setConnected(false)` side effect).
   *   - Idempotent: calling with no live connection is a no-op and
   *     never throws. `logout()` and `disconnect()` rely on this.
   *   - Does NOT dispatch `connected-changed` — callers that need a
   *     synchronous `connected=false` event must call
   *     `_setConnected(false)` themselves (logout / disconnect do;
   *     connect / reconnect rely on their handshake paths instead).
   *
   * Close code `1000 Normal Closure` with a `"Client disconnect"`
   * reason is sent explicitly. `ws.close()` with no arguments maps to
   * close code `1005 (No Status Received)`, which the WebSocket
   * protocol reserves for "no code was supplied" — that misleadingly
   * suggests an incomplete close to the server side and conflicts
   * with SPEC-REMOTE's close-code table, which expects 1000 for
   * voluntary client-initiated closes (normal logout / SPA unmount /
   * reconnect handshake). Explicit code + reason also give
   * server-side observability (close logs, metrics) a clear signal to
   * distinguish voluntary disconnect from network-level failure.
   *
   * `ws.close()` is wrapped in try/catch as defense-in-depth. Standard
   * browser WebSocket and `ws` in Node never throw synchronously from
   * `close()`, but alternative runtimes (Deno, Bun, custom polyfills,
   * test doubles) have differed historically — and a synchronous
   * throw here would propagate into callers that expect this helper
   * to be infallible (logout, disconnect, connect's pre-connect
   * cleanup), leaking a half-cleaned state where `_ws` stays non-null
   * and the next `_closeWebSocket()` / `failIfConnected` guard fires
   * against a dead socket.
   */
  private _closeWebSocket(): void {
    if (this._ws) {
      const ws = this._ws;
      this._ws = null;
      try {
        ws.close(1000, "Client disconnect");
      } catch {
        // See JSDoc — swallow runtime-specific synchronous throws so
        // the caller observes a clean teardown. The transport's own
        // close path will still fire via the socket's async `close`
        // event if the socket actually transitioned.
      }
    }
    if (this._transport) {
      this._transport.dispose();
      this._transport = null;
    }
  }

  private _createTransport(ws: WebSocket): InterceptingClientTransport {
    const transport = new InterceptingClientTransport(ws);
    this._transport = transport;
    return transport;
  }
}

class InterceptingClientTransport implements ClientTransport {
  private _base: WebSocketClientTransport;
  private _handler: ((message: ServerMessage) => void) | null = null;
  private _responseInterceptors = new Map<string, (message: RefreshResponseMessage) => void>();

  constructor(ws: WebSocket) {
    this._base = new WebSocketClientTransport(ws);
    this._base.onMessage((message) => {
      if ((message.type === "return" || message.type === "throw") && this._maybeIntercept(message)) {
        return;
      }
      this._handler?.(message);
    });
  }

  send(message: ClientMessage): void {
    this._base.send(message);
  }

  onMessage(handler: (message: ServerMessage) => void): void {
    this._handler = handler;
  }

  onClose(handler: () => void): void {
    this._base.onClose?.(handler);
  }

  dispose(): void {
    this._responseInterceptors.clear();
    this._handler = null;
    this._base.dispose?.();
  }

  interceptResponse(id: string, handler: (message: RefreshResponseMessage) => void): () => void {
    this._responseInterceptors.set(id, handler);
    return () => {
      if (this._responseInterceptors.get(id) === handler) {
        this._responseInterceptors.delete(id);
      }
    };
  }

  private _maybeIntercept(message: RefreshResponseMessage): boolean {
    const handler = this._responseInterceptors.get(message.id);
    if (!handler) return false;
    this._responseInterceptors.delete(message.id);
    handler(message);
    return true;
  }
}

function _getErrorMessage(error: unknown): string {
  if (
    error &&
    typeof error === "object" &&
    "message" in error &&
    typeof (error as { message: unknown }).message === "string"
  ) {
    return (error as { message: string }).message;
  }
  return "Token refresh failed";
}
