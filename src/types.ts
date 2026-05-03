export interface ITagNames {
  readonly auth: string;
  readonly authLogout: string;
  readonly authSession: string;
}

export interface IWritableTagNames {
  auth?: string;
  authLogout?: string;
  authSession?: string;
}

export interface IConfig {
  readonly autoTrigger: boolean;
  readonly triggerAttribute: string;
  readonly tagNames: ITagNames;
}

export interface IWritableConfig {
  autoTrigger?: boolean;
  triggerAttribute?: string;
  tagNames?: IWritableTagNames;
}

export interface IWcBindableProperty {
  readonly name: string;
  readonly event: string;
  /**
   * Optional event-payload extractor for adapters that do not infer
   * the new value from the standard `event.detail` convention. This
   * field is part of the wc-bindable protocol surface and is consumed
   * by external adapters (`@wc-bindable/core`, framework bridges) —
   * it is intentionally NOT read inside this package, but the
   * declaration must remain for protocol compatibility.
   */
  readonly getter?: (event: Event) => unknown;
}

export interface IWcBindable {
  readonly protocol: "wc-bindable";
  readonly version: number;
  /**
   * Marked `readonly` (both reference and elements) so a downstream
   * consumer cannot mutate the shared declaration — `Auth.wcBindable`
   * spreads `AuthShell.wcBindable.properties` and then appends, so a
   * `properties.push(...)` from outside would otherwise leak into
   * every consumer that reads the shared array.
   */
  readonly properties: readonly IWcBindableProperty[];
}

/**
 * Auth0 user profile returned after authentication.
 *
 * Custom claims (anything beyond `sub` / `name` / `email` / `picture`)
 * are typed as `unknown` to force callers to narrow at the boundary —
 * `[key: string]: any` would silently propagate untrusted runtime data
 * into typed code paths.
 */
export interface AuthUser {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
  [key: string]: unknown;
}

/**
 * Auth0 authentication error.
 *
 * Vendor-specific extra fields are typed as `unknown` for the same
 * narrow-at-boundary reason as `AuthUser`.
 */
export interface AuthError {
  error: string;
  error_description?: string;
  [key: string]: unknown;
}

/**
 * Value types for AuthCore (headless) — the async state properties.
 */
export interface AuthCoreValues {
  authenticated: boolean;
  user: AuthUser | null;
  token: string | null;
  loading: boolean;
  error: AuthError | Error | null;
}

/**
 * Value types for the `<auth0-gate>` custom element — the bindable
 * surface seen by `data-wcs`-style binding systems.
 *
 * This intentionally does NOT include `token`: the access token is
 * deliberately kept out of the bindable surface (security — see the
 * remote spec) and is exposed only as a JS-only getter / `getToken()`
 * method on the element. `connected` is included instead, and the
 * element adds `trigger` on top of the Shell's bindable properties.
 */
export interface AuthValues extends AuthShellValues {
  trigger: boolean;
}

// ---------------------------------------------------------------------------
// Deprecated legacy aliases (Wcs* prefix is a `@wcstack` artifact).
// Kept for backward compatibility — schedule removal in a future major.
// ---------------------------------------------------------------------------

/** @deprecated Renamed to {@link AuthUser}. The `Wcs` prefix was a legacy `@wcstack` artifact. */
export type WcsAuthUser = AuthUser;

/** @deprecated Renamed to {@link AuthError}. The `Wcs` prefix was a legacy `@wcstack` artifact. */
export type WcsAuthError = AuthError;

/** @deprecated Renamed to {@link AuthCoreValues}. The `Wcs` prefix was a legacy `@wcstack` artifact. */
export type WcsAuthCoreValues = AuthCoreValues;

/** @deprecated Renamed to {@link AuthValues}. The `Wcs` prefix was a legacy `@wcstack` artifact. */
export type WcsAuthValues = AuthValues;

/**
 * Auth0 client configuration options passed to createAuth0Client.
 *
 * Extra fields (beyond the named ones below) are typed as `unknown`
 * to force narrow-at-boundary handling. The Auth0 SPA SDK accepts a
 * loosely-typed options bag, so this interface is forwarded through
 * `as any` at the SDK call site rather than letting `any` leak into
 * caller code.
 */
export interface Auth0ClientOptions {
  domain: string;
  clientId: string;
  authorizationParams?: {
    redirect_uri?: string;
    audience?: string;
    scope?: string;
    [key: string]: unknown;
  };
  cacheLocation?: "memory" | "localstorage";
  useRefreshTokens?: boolean;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Remote CSBC types
// ---------------------------------------------------------------------------

/**
 * Value types for AuthShell — the remote-capable authentication shell.
 * Unlike AuthCoreValues, this omits `token` (security) and adds `connected`.
 */
export interface AuthShellValues {
  authenticated: boolean;
  user: AuthUser | null;
  loading: boolean;
  error: AuthError | Error | null;
  connected: boolean;
}

/**
 * Deployment mode for AuthShell / `<auth0-gate>`.
 *
 * - `"local"`: Auth0-only. `.token` / `getToken()` are JS-reachable so the
 *   application can attach `Authorization: Bearer` headers to outbound
 *   fetches.
 * - `"remote"`: the access token is held inside AuthShell and sent on the
 *   wire only at the WebSocket handshake and during in-band `auth:refresh`.
 *   `.token` returns `null` and `getToken()` throws — applications rely on
 *   the remote transport for auth and use `getTokenExpiry()` for refresh
 *   scheduling.
 */
export type AuthMode = "local" | "remote";

/**
 * Options for AuthShell.initialize().
 */
export interface AuthShellOptions {
  domain: string;
  clientId: string;
  /**
   * Auth0 API identifier (audience for the access token).
   *
   * Optional: when omitted (or passed as an empty string) the Auth0 SPA
   * SDK issues an opaque access token tied only to the ID token flow.
   * Set this to the API identifier whenever the application either
   * (a) attaches `Authorization: Bearer` headers to a backend,
   * (b) runs in remote mode (server-side `verifyAuth0Token` enforces
   *     an `aud` match — missing audience causes handshake rejection),
   * or (c) relies on RBAC `permissions` / `roles` claims.
   * In those cases, treat it as effectively required.
   */
  audience?: string;
  /** OAuth scope (default: "openid profile email"). */
  scope?: string;
  /** Redirect URI (default: window.location.origin). */
  redirectUri?: string;
  /** Cache location (default: "memory"). */
  cacheLocation?: "memory" | "localstorage";
  /** Whether to use Refresh Tokens (default: true — recommended). */
  useRefreshTokens?: boolean;
  /** Deployment mode (default: "local"). See {@link AuthMode}. */
  mode?: AuthMode;
}

// ---------------------------------------------------------------------------
// Server-side types
// ---------------------------------------------------------------------------

/**
 * User context built after JWT verification on the server.
 */
export interface UserContext {
  /** Auth0 user identifier (e.g. "auth0|abc123"). */
  sub: string;
  email?: string;
  name?: string;
  /** Auth0 RBAC permissions array. */
  permissions: string[];
  /** Auth0 RBAC roles array. */
  roles: string[];
  /** Organization ID for multi-tenancy. */
  orgId?: string;
  /** Raw JWT payload for custom claim access. */
  raw: Record<string, unknown>;
}

/**
 * Options for the server-side authenticated connection handler.
 */
export interface AuthenticatedConnectionOptions {
  auth0Domain: string;
  auth0Audience: string;
  /** Allowed Origin list (CSRF prevention). */
  allowedOrigins?: string[];
  /**
   * JWT claim key used to read Auth0 RBAC roles. Forwarded to
   * `verifyAuth0Token` — see `VerifyTokenOptions.rolesClaim`. Leave
   * unset for tenants whose custom Action emits `roles` under the
   * non-namespaced key; set to a namespaced URI (e.g.
   * `"https://api.example.com/roles"`) for the default Auth0 RBAC
   * flow, which otherwise leaves `UserContext.roles` empty.
   */
  rolesClaim?: string;
  /** Core factory — generates Core(s) from verified user context. */
  createCores: (user: UserContext) => EventTarget;
  /**
   * Propagate a refreshed UserContext into the Core(s) after an in-band
   * `auth:refresh`. Required when token claims (permissions, roles, ...)
   * can change across refreshes and the Core exposes them — otherwise
   * server-side bindable state goes stale relative to the latest token.
   *
   * May be sync or async; the handler is awaited and the refresh
   * commit only proceeds if it resolves. A sync throw or async rejection
   * rolls back the refresh and is reported as `auth:refresh-failure`.
   *
   * **Atomicity contract — caller responsibility.** The connection
   * handler does NOT undo state mutations the hook already pushed
   * onto the wire via `RemoteShellProxy` property events: if the hook
   * mutates the Core mid-execution and THEN rejects/throws, the
   * partial update is already observable by the client even though
   * the server emits `auth:refresh-failure`. Perform Core mutations
   * atomically — typically as the final action before return — or
   * wrap multi-step mutations in Core-level transactional logic.
   *
   * For the reference `UserCore`, pass `(core, user) => core.updateUser(user)`
   * — its `updateUser` is a single-call atomic update.
   */
  onTokenRefresh?: (core: EventTarget, user: UserContext) => void | Promise<void>;
  proxyOptions?: import("@wc-bindable/remote").RemoteShellProxyOptions;
  /**
   * Maximum WebSocket message size in bytes accepted by the server.
   *
   * Forwarded to `new WebSocketServer({ maxPayload })`. The `ws`
   * library itself defaults to 100 MiB which is far larger than any
   * legitimate `auth:refresh` (a JWT — a few KiB at most) or normal
   * RPC frame, so a hostile or buggy client could pin a connection
   * worth of memory by streaming a single oversized frame.
   *
   * The default applied here (256 KiB) is sized for typical RPC-style
   * commands (small JSON payloads, occasional larger argument
   * blobs); applications that legitimately push larger frames
   * through a single connection can override.
   *
   * Default: `262144` (256 KiB).
   */
  maxPayload?: number;
  /**
   * Minimum interval (in milliseconds) between successful in-band
   * `auth:refresh` operations on a single connection.
   *
   * A second refresh that arrives within `minRefreshIntervalMs` of a
   * just-committed refresh is rejected with `auth:refresh-failure`
   * (`"Token refresh rate limit exceeded"`) before the new token is
   * verified or `onTokenRefresh` runs. The previously honoured
   * session expiry stays untouched. Defends against a client that
   * spins on `auth:refresh` (bug or hostile probe) — without the
   * limit, every iteration runs `verifyAuth0Token` (a network
   * round-trip to the JWKS endpoint plus signature check) and the
   * application's `onTokenRefresh` hook against the same token,
   * pinning CPU on the server for no productive work.
   *
   * SPEC-REMOTE §3.4.1 already enforces a one-at-a-time refresh on
   * each connection through `refreshInFlight`; this option adds a
   * minimum gap BETWEEN successful refreshes so a fast loop cannot
   * sustain back-to-back refreshes the moment each one returns.
   * `0` disables the rate limit (legacy behaviour).
   *
   * Default: `5000` (5 seconds).
   */
  minRefreshIntervalMs?: number;
}

/**
 * Options for verifyAuth0Token().
 */
export interface VerifyTokenOptions {
  domain: string;
  audience: string;
  /**
   * JWT claim key that holds the Auth0 RBAC roles array.
   *
   * Auth0's default RBAC configuration emits roles as a namespaced
   * custom claim (e.g. `https://example.com/roles`) because Auth0
   * reserves non-namespaced claims for its OIDC payload. SPEC-REMOTE
   * §4.2 documents the expected shape as
   * `payload["https://{namespace}/roles"]`.
   *
   * When this option is set, `verifyAuth0Token` reads roles from the
   * given claim key first and falls back to the non-namespaced
   * `payload.roles` only if the namespaced key is absent. When unset,
   * the legacy `payload.roles` lookup is used, matching pre-existing
   * deployments that emit roles through a custom Action into the
   * non-namespaced key.
   *
   * Leave unset for Auth0 tenants that have a custom Action emitting
   * `event.accessToken.setCustomClaim("roles", …)`; set to your
   * namespaced URI (e.g. `"https://api.example.com/roles"`) for the
   * out-of-the-box Auth0 RBAC "Add Permissions in the Access Token"
   * flow combined with a namespaced roles claim.
   */
  rolesClaim?: string;
  /**
   * Clock tolerance forwarded to `jwtVerify` when checking `exp` /
   * `iat` / `nbf`. Accepts the same shape `jose` accepts — a number of
   * seconds or a string like `"30s"` / `"2m"`. Default: `"30s"`.
   *
   * Without a tolerance, normal NTP drift between the Auth0 issuer and
   * the verifying server (or a freshly-minted token whose `iat` is a
   * fraction of a second in the future from the server's clock)
   * surfaces as `"exp" claim timestamp check failed` / `"iat" claim
   * timestamp check failed` rejections, closing the WebSocket with
   * 1008 mid-handshake.
   */
  clockTolerance?: string | number;
}
