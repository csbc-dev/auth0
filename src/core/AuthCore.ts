import { raiseError } from "../raiseError.js";
import { getTokenExpiryMs } from "../jwtPayload.js";
import { IWcBindable, Auth0ClientOptions, AuthUser, AuthError } from "../types.js";

/**
 * Normalise an `unknown` caught value into a shape compatible with
 * `AuthShellValues.error` / `AuthCoreValues.error` (`AuthError | Error | null`).
 *
 * Auth0 SPA SDK errors arrive as `AuthError`-shaped plain objects
 * (`{ error, error_description, ... }`) rather than `Error` instances,
 * so we pass those through as-is; anything else is wrapped into a real
 * `Error` so subscribers of `auth0-gate:error` observe a uniform
 * `{ message: string }` surface instead of a raw string / number / etc.
 */
function _normalizeAuthError(err: unknown): AuthError | Error {
  if (err instanceof Error) return err;
  if (
    err !== null &&
    typeof err === "object" &&
    typeof (err as { error?: unknown }).error === "string"
  ) {
    return err as AuthError;
  }
  return new Error(typeof err === "string" ? err : String(err));
}

/**
 * Headless authentication core based on Auth0 SPA SDK.
 * Requires browser globals (location, history) for redirect callback handling.
 *
 * Error delivery contract:
 *   - Synchronous methods (`initialize` invoked with a missing
 *     `domain`/`clientId`) throw synchronously via `raiseError`.
 *   - `async` methods (`login`, `loginWithPopup`, `logout`,
 *     `getToken`, `fetchToken`, `fetchFreshToken`) convert any
 *     synchronous `raiseError` at the top of the body into a
 *     rejected promise — a consequence of `async function` boxing —
 *     so callers always `await` them and catch via `.catch(...)`
 *     rather than `try/catch` around the call expression. This is
 *     intentional: the uniform "failure arrives as a promise
 *     rejection" shape keeps `AuthShell` / `<auth0-gate>`
 *     delegators' error handling simple. The same applies to
 *     recoverable Auth0 SDK errors, which additionally update
 *     `_error` and emit `auth0-gate:error` for binding subscribers.
 */
export class AuthCore extends EventTarget {
  /**
   * **Security contract — `token` listed here is intentional, scope-limited.**
   *
   * `token` IS published on `AuthCore.wcBindable.properties` so that an
   * in-process consumer (e.g. an `AuthShell` that constructs the Core
   * directly, or a unit test that drives Auth0 via the headless Core)
   * can observe `auth0-gate:token-changed` through the wcBindable
   * declaration. The CLAUDE.md "token must NEVER appear in the
   * wcBindable surface" rule applies to the **`<auth0-gate>` element**
   * surface — `AuthShell.wcBindable` (omits `token`) and
   * `Auth.wcBindable` (extends `AuthShell.wcBindable`, also omits
   * `token`) — which is what `data-wcs` and equivalent declarative
   * binders attach to. AuthCore is the in-runtime decision Core, never
   * directly bound by external `data-wcs` consumers, so the token
   * declaration here does NOT leak the bearer through the documented
   * Shell binding surface. Removing it would break `AuthShell`'s
   * internal `commitToken()` → `auth0-gate:token-changed` subscribers
   * that rely on the Core's wcBindable declaration to discover the
   * event name (and the published unit-test contract that this
   * package's `AuthCore` sits across — see __tests__/authCore.test.ts).
   *
   * **Direct-Core consumer responsibility (REMOTE MODE):**
   *
   * `AuthCore` IS a public package export ([src/index.ts]) so a
   * downstream caller can construct a Core directly and `bind()` it
   * via `@wc-bindable/core` — that path receives `token` because this
   * declaration includes it. The remote-mode "token never reachable
   * from JS" guarantee published by the README is implemented by:
   *
   *   1. `AuthShell`'s relay EventTarget that drops
   *      `auth0-gate:token-changed` re-dispatch onto the outer
   *      element when `_mode === "remote"`
   *      ([src/shell/AuthShell.ts] — search "FORWARDED_EVENT_NAMES").
   *   2. `<auth0-gate>` proxying `.token` through `AuthShell` which
   *      returns `null` in remote mode, and `getToken()` throwing.
   *
   * Both safeguards live in the **Shell layer**. A consumer that
   * bypasses the Shell by constructing `new AuthCore()` directly is
   * outside the Shell's binding surface and therefore outside the
   * remote-mode token-confinement guarantee — the Shell has no way to
   * intercept events on a Core instance it does not own. Direct-Core
   * usage is supported for unit tests, advanced embedders, and
   * tooling, but the security contract for those callers is "you own
   * the token, treat it as bearer material accordingly". If you need
   * Shell-equivalent confinement programmatically, instantiate
   * `AuthShell` (which constructs its own Core internally) instead of
   * `AuthCore`.
   */
  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "authenticated", event: "auth0-gate:authenticated-changed" },
      { name: "user", event: "auth0-gate:user-changed" },
      { name: "token", event: "auth0-gate:token-changed" },
      { name: "loading", event: "auth0-gate:loading-changed" },
      { name: "error", event: "auth0-gate:error" },
    ],
  };

  private _target: EventTarget;
  private _client: unknown = null;
  private _authenticated: boolean = false;
  private _user: AuthUser | null = null;
  private _token: string | null = null;
  private _loading: boolean = false;
  private _error: AuthError | Error | null = null;
  private _initPromise: Promise<void> | null = null;
  private _initInFlight: boolean = false;

  constructor(target?: EventTarget) {
    super();
    this._target = target ?? this;
  }

  get authenticated(): boolean {
    return this._authenticated;
  }

  get user(): AuthUser | null {
    return this._user;
  }

  get token(): string | null {
    return this._token;
  }

  get loading(): boolean {
    return this._loading;
  }

  get error(): AuthError | Error | null {
    return this._error;
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
   *
   * Mirrors the same policy applied to `AuthShell.client` — both
   * public exports present a uniform "narrow-at-use-site" surface so
   * the peer-dep type does not leak through either entry point.
   */
  get client(): unknown {
    return this._client;
  }

  /**
   * Internal escape hatch to call the Auth0 SPA SDK surface from
   * within AuthCore without sprinkling `(this._client as any)` at
   * every call site. Kept private so the `unknown`-typed public
   * `client` getter remains the sole external view — callers outside
   * AuthCore must still narrow via `as Auth0Client` themselves.
   *
   * Typed as `Auth0Client` (via type-only `import("@auth0/auth0-spa-js")`
   * — the package is a peer dependency, but type-only imports do NOT
   * pull anything into the runtime bundle) so internal SDK usage gets
   * full method-shape checking and autocomplete instead of the silent
   * `any` accepted before. Falls back to `unknown` if the peer dep is
   * not installed at TS-resolve time, which a downstream consumer
   * never hits since `@auth0/auth0-spa-js` is also a devDependency
   * of this package.
   */
  private get _sdk(): import("@auth0/auth0-spa-js").Auth0Client {
    return this._client as import("@auth0/auth0-spa-js").Auth0Client;
  }

  /**
   * The in-flight initialize() promise, or the settled promise from
   * the most recent successful initialise. Observes three distinct
   * states:
   *
   *   - `null` before `initialize()` is ever called, AND after any
   *     previous attempt **rejected** — the latter is deliberate so
   *     `<auth0-gate>`'s connectedCallback guard
   *     (`!_shell.client && !_shell.initPromise`) can fire a fresh
   *     retry on a subsequent connect. Leaving the rejected promise
   *     here would make the guard permanently false while `_client`
   *     is still null, stranding the element unrecoverably.
   *   - A pending Promise during `_doInitialize()` — coalesces
   *     concurrent `initialize()` calls onto the same attempt.
   *   - A resolved Promise after a successful initialise — lets
   *     callers `await` the ready state without racing a re-entry.
   *
   * `_initInFlight` is a synchronous sibling flag (set BEFORE the
   * first await, cleared in `finally`) that lets the guard inside
   * `initialize()` distinguish "pending" from "settled" without
   * inspecting the promise state.
   */
  get initPromise(): Promise<void> | null {
    return this._initPromise;
  }

  /**
   * Return the current access token's expiry as a millisecond epoch,
   * or `null` if no token is held or the token has no `exp` claim.
   *
   * Exposes the `exp` claim only — the raw token material never leaves
   * AuthCore. Intended for refresh schedulers that need to know when
   * to call `refreshToken()` without touching the token string.
   *
   * Delegates to `jwtPayload.getTokenExpiryMs`, which guards against
   * non-object JWT payloads (`null`, primitives) that would otherwise
   * throw a `TypeError` under a bare `payload.exp` read.
   */
  getTokenExpiry(): number | null {
    return getTokenExpiryMs(this._token);
  }

  private _setLoading(loading: boolean): void {
    this._loading = loading;
    this._target.dispatchEvent(new CustomEvent("auth0-gate:loading-changed", {
      detail: loading,
      bubbles: true,
    }));
  }

  private _setError(error: AuthError | Error | null): void {
    this._error = error;
    this._target.dispatchEvent(new CustomEvent("auth0-gate:error", {
      detail: error,
      bubbles: true,
    }));
  }

  private _setAuthenticated(value: boolean): void {
    this._authenticated = value;
    this._target.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setUser(user: AuthUser | null): void {
    this._user = user;
    this._target.dispatchEvent(new CustomEvent("auth0-gate:user-changed", {
      detail: user,
      bubbles: true,
    }));
  }

  private _setToken(token: string | null): void {
    this._token = token;
    this._target.dispatchEvent(new CustomEvent("auth0-gate:token-changed", {
      detail: token,
      bubbles: true,
    }));
  }

  /**
   * Initialize the Auth0 client and handle redirect callback if needed.
   *
   * Coalesces concurrent calls: while a previous `_doInitialize` is
   * still awaiting `createAuth0Client` / `handleRedirectCallback` /
   * `_syncState`, a second `initialize()` returns the same in-flight
   * promise instead of racing a parallel Auth0 client construction.
   * Defense-in-depth against lifecycle paths (e.g. disconnect→reconnect
   * landing inside the init microtask gap); programmatic retry after
   * the previous attempt has settled is still supported — `_initInFlight`
   * clears in `finally`, so a post-failure retry starts a fresh attempt.
   */
  initialize(options: Auth0ClientOptions): Promise<void> {
    // Phrased in terms of the `options` field rather than the `<auth0-gate>`
    // attribute because AuthCore has no knowledge of the element — upstream
    // callers (the custom element) can rewrite the message to point at the
    // offending attribute if their UX benefits from that.
    if (!options.domain) {
      raiseError("domain is required.");
    }
    if (!options.clientId) {
      raiseError("clientId is required.");
    }

    if (this._initInFlight && this._initPromise) {
      return this._initPromise;
    }

    const p = this._doInitialize(options);
    this._initPromise = p;
    return p;
  }

  private async _doInitialize(options: Auth0ClientOptions): Promise<void> {
    this._initInFlight = true;
    this._setLoading(true);
    this._setError(null);

    try {
      const { createAuth0Client } = await import("@auth0/auth0-spa-js");
      this._client = await createAuth0Client({
        domain: options.domain,
        clientId: options.clientId,
        authorizationParams: options.authorizationParams,
        cacheLocation: options.cacheLocation,
        useRefreshTokens: options.useRefreshTokens,
      });

      // リダイレクトコールバックの処理
      //
      // `URLSearchParams.has()` で `code` / `state` を厳密一致で判定する。
      // 素の `query.includes("code=")` だと `?promo_code=abc&session_state=xyz`
      // のような「別キーに `code` / `state` が部分文字列として含まれる URL」を
      // 誤検知し、Auth0 SDK が `handleRedirectCallback()` で "Invalid state"
      // 等を投げて初期化全体が失敗する。
      const query = globalThis.location?.search || "";
      const params = new URLSearchParams(query);
      if (params.has("code") && params.has("state")) {
        await this._sdk.handleRedirectCallback();
        // URLからcode/stateパラメータのみ除去（他のパラメータは保持）
        const url = new URL(globalThis.location.href);
        url.searchParams.delete("code");
        url.searchParams.delete("state");
        globalThis.history.replaceState({}, document.title, url.toString());
      }

      await this._syncState();
      this._setLoading(false);
    } catch (e: unknown) {
      this._setError(_normalizeAuthError(e));
      this._setLoading(false);
      // Clear the settled promise on failure so that <auth0-gate>'s
      // connectedCallback guard (`!_shell.client && !_shell.initPromise`)
      // can fire a fresh attempt on a subsequent connect (e.g. a
      // disconnect→reconnect retry after a transient network / Auth0
      // outage). Leaving the resolved promise in place would make the
      // guard permanently false while `_client` stays null, stranding
      // the element in an unrecoverable error state without an
      // imperative `initialize()` call.
      this._initPromise = null;
    } finally {
      this._initInFlight = false;
    }
  }

  /**
   * Sync authentication state from the Auth0 client.
   *
   * On `getTokenSilently()` rejection we keep `_authenticated === true`
   * (the user IS authenticated — we just cannot hand out a token right
   * now, typically due to a refresh-token outage or a third-party cookie
   * block) but publish the SDK error through `_setError` so subscribers
   * can distinguish "no token yet" from "token silently missing". Before
   * this, `_syncState` cleared the error on entry (via `_doInitialize`'s
   * `_setError(null)`) and then swallowed the rejection in a bare catch,
   * so downstream code saw `authenticated=true` / `token=null` /
   * `error=null` and had no signal that Authorization headers would fail
   * in local mode. Mirrors `getToken()`'s error contract — both paths
   * now surface Auth0 SDK failures uniformly through `error`.
   */
  private async _syncState(): Promise<void> {
    const isAuthenticated = await this._sdk.isAuthenticated();
    this._setAuthenticated(isAuthenticated);

    if (isAuthenticated) {
      const user = await this._sdk.getUser();
      // Auth0's `User` type declares `sub: string | undefined`, but the
      // OIDC contract guarantees that an authenticated user has a `sub`.
      // Cast through the package's local `AuthUser` to bring the type
      // back in line with downstream consumers that rely on `sub`
      // being present whenever `authenticated === true`.
      this._setUser((user as AuthUser | undefined) ?? null);

      try {
        const token = await this._sdk.getTokenSilently();
        this._setToken(token ?? null);
      } catch (e: unknown) {
        // Keep authenticated=true (the SDK session is real), but publish
        // the SDK failure so subscribers can react. Not fatal to the
        // initialise — outer `_doInitialize` clears `loading` normally.
        this._setToken(null);
        this._setError(_normalizeAuthError(e));
      }
    } else {
      this._setUser(null);
      this._setToken(null);
    }
  }

  /**
   * Redirect to Auth0 login page.
   *
   * In production `loginWithRedirect` navigates away and never
   * resolves — the `loading=true` dispatched just above rides out
   * with the page. Test doubles and certain Auth0 SDK configurations
   * (e.g. silent auth that short-circuits the redirect) can return
   * normally, so we also clear `loading` after a clean resolve to
   * keep the flag from sticking at `true` across a completed call
   * that never actually navigated.
   *
   * NB: `login()` is declared `async`, so the preconditions
   * (`raiseError` on missing client) reject the returned promise
   * instead of throwing synchronously. This is intentional —
   * `<auth0-gate>.login()` awaits `connectedCallbackPromise` before
   * delegating, and propagating failure via promise rejection keeps
   * the asynchronous failure surface uniform across `login` /
   * `loginWithPopup` / `logout` / `connect`.
   */
  async login(options?: Record<string, any>): Promise<void> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setLoading(true);
    this._setError(null);

    try {
      await this._sdk.loginWithRedirect({
        authorizationParams: options,
      });
      // リダイレクト後は通常ここに到達しないが、到達した場合（テスト・SDK分岐）は
      // loading フラグを解除する
      this._setLoading(false);
    } catch (e: unknown) {
      this._setError(_normalizeAuthError(e));
      this._setLoading(false);
    }
  }

  /**
   * Login via popup window.
   */
  async loginWithPopup(options?: Record<string, any>): Promise<void> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setLoading(true);
    this._setError(null);

    try {
      await this._sdk.loginWithPopup({
        authorizationParams: options,
      });
      await this._syncState();
      this._setLoading(false);
    } catch (e: unknown) {
      this._setError(_normalizeAuthError(e));
      this._setLoading(false);
    }
  }

  /**
   * Logout from Auth0.
   *
   * On Auth0 SDK rejection we still clear the local `authenticated` /
   * `user` / `token` state. Rationale:
   *
   *   - `AuthShell.logout` has already torn down the remote WebSocket
   *     (`_closeWebSocket()` + synchronous `_setConnected(false)`) by
   *     the time we're called, so "still authenticated in JS" is an
   *     inconsistent surface: bindings would show the user as signed
   *     in while the server has no live session for them.
   *   - Holding on to `_token` after a failed logout leaves cached
   *     material longer than the user intended to. Minimum-privilege
   *     for an aborted-but-not-reversed logout is to drop local
   *     tokens and let the caller retry if they need a full Auth0
   *     round-trip later.
   *
   * Trade-off: the Auth0 SPA SDK's internal session (cookie / refresh
   * token storage) may still be live if the network call failed. A
   * subsequent `login()` will pick that up via silent auth. That's
   * the correct behaviour — we prefer "local state says signed out"
   * to "local state lies because the server unreachable".
   */
  async logout(options?: Record<string, any>): Promise<void> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setError(null);

    try {
      await this._sdk.logout(options);
    } catch (e: unknown) {
      this._setError(_normalizeAuthError(e));
    } finally {
      this._setAuthenticated(false);
      this._setUser(null);
      this._setToken(null);
    }
  }

  /**
   * Get access token silently (from cache or via refresh).
   *
   * Returns:
   *   - `string` — the access token, when the Auth0 SDK successfully
   *     returns one (and updates `_token`).
   *   - `null` in two distinct situations:
   *     1. The SDK returned `null`/`undefined` (no token currently
   *        cached and silent refresh is unavailable). `_error` stays
   *        unchanged and `auth0-gate:error` does not fire.
   *     2. The SDK rejected — `null` is the swallowed-failure return.
   *        In this case `_error` IS updated and `auth0-gate:error`
   *        IS dispatched. Callers that need to distinguish the two
   *        must inspect `error` alongside the returned value (read
   *        immediately after the await; subsequent operations may
   *        clear it).
   *
   * This contract intentionally never rejects — see the class JSDoc
   * "Error delivery contract" — so a silent `null` followed by an
   * unchecked use can mask a recoverable Auth0 outage. Refresh
   * schedulers should treat `null` as a failure-or-absence signal and
   * branch on `error !== null` to decide whether to retry.
   */
  async getToken(options?: Record<string, any>): Promise<string | null> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setError(null);

    try {
      const token = await this._sdk.getTokenSilently(options);
      this._setToken(token ?? null);
      return this._token;
    } catch (e: unknown) {
      this._setError(_normalizeAuthError(e));
      return null;
    }
  }

  /**
   * Obtain an access token from Auth0 SPA SDK and return it
   * **without** updating `_token`. The caller is responsible for
   * handing the token to whatever downstream system must accept it —
   * typically the server — and only then calling `commitToken(token)`
   * to publish the new value to `_token` / `getTokenExpiry()` and
   * fire `token-changed`.
   *
   * Splitting fetch from commit keeps the invariant that `_token`
   * (and therefore `getTokenExpiry()`) reflects the token the
   * **server** has accepted, so that refresh schedulers cannot be
   * misled by a locally-obtained token that a downstream actor later
   * rejected. Use this in every connection establishment / refresh
   * path; only call `commitToken` after the server confirms acceptance.
   *
   * `options` is forwarded to `getTokenSilently` (e.g. pass
   * `{ cacheMode: "off" }` to force a network refresh).
   *
   * Mirrors `getToken`'s error semantics: when the Auth0 SDK rejects,
   * `_error` is set and `auth0-gate:error` is dispatched, then `null`
   * is returned. This keeps the observable error contract consistent
   * across `connect` / `refreshToken` / `reconnect` so callers can
   * uniformly translate `null` into a domain-specific message
   * (e.g. "Failed to obtain access token.").
   */
  async fetchToken(options?: Record<string, any>): Promise<string | null> {
    if (!this._client) {
      raiseError("Auth0 client is not initialized. Call initialize() first.");
    }

    this._setError(null);

    try {
      const token = await this._sdk.getTokenSilently(options);
      return token ?? null;
    } catch (e: unknown) {
      this._setError(_normalizeAuthError(e));
      return null;
    }
  }

  /**
   * Convenience wrapper for `fetchToken({ cacheMode: "off" })` —
   * forces Auth0 to issue a fresh access token instead of returning
   * a cached one. Same fetch-without-commit semantics as `fetchToken`.
   */
  async fetchFreshToken(): Promise<string | null> {
    return this.fetchToken({ cacheMode: "off" });
  }

  /**
   * Commit a token that has already been accepted by the downstream
   * system (server handshake, in-band `auth:refresh`, or a fresh
   * WebSocket `open`). Updates `_token` and dispatches `token-changed`.
   */
  commitToken(token: string | null): void {
    this._setToken(token);
  }
}
