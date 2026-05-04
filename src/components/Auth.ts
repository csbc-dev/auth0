import type { ClientTransport } from "@wc-bindable/remote";
import { config } from "../config.js";
import { IWcBindable, AuthMode, AuthError, AuthUser } from "../types.js";
import { AuthShell, DEFAULT_SCOPE } from "../shell/AuthShell.js";
import { registerAutoTrigger, unregisterAutoTrigger } from "../autoTrigger.js";
import { ERROR_PREFIX } from "../raiseError.js";

// Attributes whose value the Auth0 SPA SDK consumes ONCE at
// construction time (`audience`, `scope`, `redirect-uri`, `cache-location`,
// `use-refresh-tokens`). Mutating any of them post-init does NOT
// reconfigure the live SDK — the SDK keys its session storage by
// `audience`, partitions cache by `scope` / `cache-location`, and binds
// refresh-token usage at construction. The browser still delivers
// `attributeChangedCallback` for them because they're in
// `observedAttributes`, so a framework re-stamp or an explicit mid-life
// `setAttribute` would silently no-op while the operator believes the
// change took effect; `attributeChangedCallback` warns once when this
// drift is detected. Hoisted to module scope so the array is allocated
// once at module-load instead of per-call.
//
// `mode` and `remote-url` are intentionally NOT in this list — both are
// mirrored into the shell on change and the connect()/reconnect() paths
// re-validate them (e.g. remote-mode audience precondition). However,
// the inert-attribute warning text below explicitly notes that switching
// `mode` post-init still leaves the Auth0 SDK constructed with the
// original `cache-location` / `use-refresh-tokens` values, so a
// `local`→`remote` flip can leave the SDK partially misaligned with the
// new mode's expectations even though the shell-side state advances.
const _INERT_POST_INIT_ATTRIBUTES = [
  "audience",
  "scope",
  "redirect-uri",
  "cache-location",
  "use-refresh-tokens",
];

export class Auth extends HTMLElement {
  static hasConnectedCallbackPromise = true;
  static wcBindable: IWcBindable = {
    ...AuthShell.wcBindable,
    properties: [
      ...AuthShell.wcBindable.properties,
      { name: "trigger", event: "auth0-gate:trigger-changed" },
    ],
  };
  static get observedAttributes(): string[] {
    return [
      "domain", "client-id", "redirect-uri", "audience", "scope",
      "remote-url", "mode", "cache-location", "use-refresh-tokens",
    ];
  }

  private _shell: AuthShell;
  private _trigger: boolean = false;
  private _connectedCallbackPromise: Promise<void> = Promise.resolve();
  private _initScheduled = false;
  // Track whether THIS instance called registerAutoTrigger(), so that
  // disconnectedCallback can pair it with a single unregisterAutoTrigger().
  // Required because `config.autoTrigger` may toggle between connect
  // and disconnect — without this flag a false reading on disconnect
  // would unbalance the refcount in autoTrigger.ts.
  private _autoTriggerRegistered: boolean = false;
  // One-shot guard for the unknown-`mode` console.warn. Per-instance
  // because the wrong attribute is per-instance; a single page can
  // legitimately have multiple `<auth0-gate>` mounts and a typo on
  // one should not silence a future typo on another.
  private _unknownModeWarned: boolean = false;
  // One-shot guard for the remote-mode-without-audience warn.
  // Per-instance because the wrong configuration is per-instance: a
  // single page can legitimately have multiple `<auth0-gate>` mounts
  // (different APIs / audiences) and a typo on one should not silence
  // a future typo on another. Latched after the first warn so a
  // framework that re-reads `mode` / `audience` repeatedly does not
  // flood the console with the same message.
  //
  // Why a warn (not a synchronous throw):
  //   The misconfiguration is only visible on the wire — the Auth0
  //   SPA SDK accepts `getTokenSilently()` without an `audience`
  //   parameter (it just returns whatever default-audience token Auth0
  //   chose for the tenant), so a remote-mode element that never
  //   reaches connect() (e.g. a "loading…" indicator that observes
  //   `authenticated` / `user` only, awaiting the page's main shell to
  //   call connect()) would never see the connect()-side raiseError.
  //   The warn surfaces the issue at attribute-stamp time so
  //   integrators see it during local dev instead of debugging a 1008
  //   close in production. Throwing here would be hostile to
  //   late-binding frameworks that stamp `mode` before `audience`.
  private _remoteAudienceMissingWarned: boolean = false;
  // One-shot guard for the post-init "inert attribute mutated" warn.
  // The Auth0 SPA SDK is constructed once with `audience` / `scope` /
  // `redirect-uri` / `cache-location` / `use-refresh-tokens` plumbed
  // straight into its options; mutating any of these attributes
  // post-init does NOT reconfigure the live SDK (the SDK keys its
  // session storage by audience, scope and cache-location all
  // partition the cache, refresh-token usage is bound at
  // construction). The browser still delivers
  // `attributeChangedCallback` for them because they're in
  // `observedAttributes`, so a framework re-stamp or an explicit
  // mid-life setAttribute would otherwise silently no-op while the
  // operator believes the change took effect. A single warn covers
  // all of them — burying the user under five separate "X mutated"
  // messages would be louder than helpful, and the fix in every case
  // is the same (tear down and remount the element). Latched so a
  // framework that re-stamps multiple inert attributes in one tick
  // does not flood the console.
  private _postInitMutationWarned: boolean = false;

  constructor() {
    super();
    this._shell = new AuthShell(this);
  }

  // --- Input attributes ---

  get domain(): string {
    return this.getAttribute("domain") || "";
  }

  set domain(value: string) {
    this.setAttribute("domain", value);
  }

  get clientId(): string {
    return this.getAttribute("client-id") || "";
  }

  set clientId(value: string) {
    this.setAttribute("client-id", value);
  }

  get redirectUri(): string {
    return this.getAttribute("redirect-uri") || "";
  }

  set redirectUri(value: string) {
    this.setAttribute("redirect-uri", value);
  }

  get audience(): string {
    return this.getAttribute("audience") || "";
  }

  set audience(value: string) {
    this.setAttribute("audience", value);
  }

  get scope(): string {
    return this.getAttribute("scope") || DEFAULT_SCOPE;
  }

  set scope(value: string) {
    this.setAttribute("scope", value);
  }

  get cacheLocation(): "memory" | "localstorage" {
    const value = this.getAttribute("cache-location");
    return value === "localstorage" ? "localstorage" : "memory";
  }

  set cacheLocation(value: "memory" | "localstorage") {
    this.setAttribute("cache-location", value);
  }

  get useRefreshTokens(): boolean {
    const v = this.getAttribute("use-refresh-tokens");
    return v === null ? true : v !== "false";
  }

  set useRefreshTokens(value: boolean) {
    this.setAttribute("use-refresh-tokens", value ? "true" : "false");
  }

  /**
   * Use Auth0's popup login flow (`loginWithPopup`) instead of the
   * default redirect (`loginWithRedirect`).
   *
   * Read on demand at every `login()` call rather than mirrored into
   * `observedAttributes` — the value only matters at the moment login
   * is invoked, and the popup-vs-redirect decision is driven by the
   * caller's intent at click time, not by long-lived state. Adding it
   * to `observedAttributes` would needlessly fire
   * `attributeChangedCallback` (and currently has no effect because
   * the callback ignores anything not listed in the init-relevant
   * set), so the on-demand read is intentional.
   */
  get popup(): boolean {
    return this.hasAttribute("popup");
  }

  set popup(value: boolean) {
    if (value) {
      this.setAttribute("popup", "");
    } else {
      this.removeAttribute("popup");
    }
  }

  get remoteUrl(): string {
    return this.getAttribute("remote-url") || "";
  }

  set remoteUrl(value: string) {
    this.setAttribute("remote-url", value);
  }

  /**
   * Deployment mode. Resolved from:
   *
   * 1. `mode` attribute, if set to `"local"` or `"remote"` (wins).
   * 2. Otherwise, implicit: `"remote"` when `remote-url` has a non-empty value,
   *    else `"local"`. An empty `remote-url=""` is treated as unset.
   *
   * In `"remote"` mode the access token is not reachable from JS —
   * `.token` returns `null` and `getToken()` throws.
   *
   * Unknown attribute values (e.g. typo `mode="remot"`) fall through
   * to the implicit resolution and emit a one-time `console.warn` so
   * the integrator sees the mistake instead of silently landing in
   * the wrong mode.
   */
  get mode(): AuthMode {
    const attr = this.getAttribute("mode");
    if (attr === "remote" || attr === "local") return attr;
    if (attr !== null && attr !== "") {
      // One-time warn per element — `_unknownModeWarned` latches so
      // a framework that re-reads `mode` repeatedly does not flood
      // the console. Implicit fallback (no attribute, or empty
      // attribute) is intentionally NOT warned.
      if (!this._unknownModeWarned) {
        this._unknownModeWarned = true;
        console.warn(
          `${ERROR_PREFIX} <auth0-gate>: unknown mode="${attr}". ` +
          `Falling back to implicit resolution (remote-url presence). ` +
          `Valid values: "local" | "remote".`,
        );
      }
    }
    return this.remoteUrl ? "remote" : "local";
  }

  set mode(value: AuthMode) {
    this.setAttribute("mode", value);
  }

  // --- Output state (delegated to shell) ---

  get authenticated(): boolean {
    return this._shell.authenticated;
  }

  get user(): AuthUser | null {
    return this._shell.user;
  }

  /**
   * Access token.
   *
   * Local mode: returns the current access token (or `null`) so application
   * code can attach `Authorization: Bearer` headers to outbound requests.
   *
   * Remote mode: always returns `null`. The token stays inside AuthShell and
   * is sent on the wire only at the WebSocket handshake and during in-band
   * `auth:refresh`. See README-REMOTE for the rationale.
   *
   * Never part of the wcBindable surface (both modes).
   */
  get token(): string | null {
    return this._shell.token;
  }

  get loading(): boolean {
    return this._shell.loading;
  }

  get error(): AuthError | Error | null {
    return this._shell.error;
  }

  get connected(): boolean {
    return this._shell.connected;
  }

  /**
   * Raw Auth0 client — exposed for advanced use only. Typed as
   * `unknown` because `@auth0/auth0-spa-js` is a peer dependency of
   * this package and the public API surface must not silently leak
   * that type to consumers who have not installed it. Narrow in the
   * calling code via `as Auth0Client` if you need the SDK methods.
   */
  get client(): unknown {
    return this._shell.client;
  }

  /**
   * Resolves once the element's `connectedCallback` has settled
   * (initialize() success or failure).
   *
   * Limitation: the promise reference is captured at the moment a
   * caller reads it. If `auto-connect` flips from `false` to `true`
   * mid-life on the paired `<auth0-session>`, or any imperative
   * `start()` is invoked after the initial connect cycle, the value
   * read PRIOR to that transition does NOT auto-update — a caller
   * that cached `el.connectedCallbackPromise` early will continue to
   * await the original (already-resolved) promise and miss the second
   * start. Re-read `connectedCallbackPromise` after any deliberate
   * mid-life restart to pick up the fresh promise.
   */
  get connectedCallbackPromise(): Promise<void> {
    return this._connectedCallbackPromise;
  }

  // --- Trigger (one-way command) ---

  get trigger(): boolean {
    return this._trigger;
  }

  set trigger(value: boolean) {
    const v = !!value;
    // Guard against double-trigger: a second `trigger=true` while a
    // previous login() is still in flight would queue a parallel
    // login() call (the `.finally()` handler has not yet fired, so
    // `_trigger` is still true). Auth0's `loginWithRedirect` tolerates
    // re-entry but the visible UX is two back-to-back navigations
    // racing each other; ignoring the redundant `true` keeps the
    // single-in-flight contract.
    if (v && this._trigger) return;
    if (v) {
      this._trigger = true;
      // Dispatch the `true` transition so wcBindable consumers see
      // BOTH `trigger=true` and the subsequent `trigger=false` —
      // before this, only the `false` reset emitted, leaving
      // `data-wcs`-bound spinners that gate on `trigger` unable to
      // observe the in-flight phase.
      this.dispatchEvent(new CustomEvent("auth0-gate:trigger-changed", {
        detail: true,
        bubbles: true,
      }));
      this._connectedCallbackPromise
        .then(() => this.login())
        .catch(() => { /* error surfaces via this.error (AuthShell state); avoid unhandled rejection */ })
        .finally(() => {
          this._trigger = false;
          this.dispatchEvent(new CustomEvent("auth0-gate:trigger-changed", {
            detail: false,
            bubbles: true,
          }));
        });
    }
  }

  // --- Methods ---

  private _buildShellOptions() {
    return {
      domain: this.domain,
      clientId: this.clientId,
      // Normalise empty attribute (`audience=""` or unset) to undefined
      // to match AuthShellOptions' optional contract — AuthShell
      // already skips `audience` when falsy, this keeps the types and
      // the runtime aligned instead of passing `""` under an optional
      // `string` type.
      audience: this.audience || undefined,
      scope: this.scope,
      redirectUri: this.redirectUri || undefined,
      cacheLocation: this.cacheLocation,
      useRefreshTokens: this.useRefreshTokens,
      mode: this.mode,
    };
  }

  async initialize(): Promise<void> {
    return this._shell.initialize(this._buildShellOptions());
  }

  async login(options?: Record<string, any>): Promise<void> {
    await this._connectedCallbackPromise;
    if (this.popup) {
      return this._shell.loginWithPopup(options);
    }
    return this._shell.login(options);
  }

  async logout(options?: Record<string, any>): Promise<void> {
    await this._connectedCallbackPromise;
    return this._shell.logout(options);
  }

  async getToken(options?: Record<string, any>): Promise<string | null> {
    await this._connectedCallbackPromise;
    return this._shell.getToken(options);
  }

  /**
   * Current access token's expiry as a millisecond epoch, or `null`.
   * Exposes only the `exp` claim; the token material stays inside the Shell.
   */
  getTokenExpiry(): number | null {
    return this._shell.getTokenExpiry();
  }

  /**
   * Establish an authenticated WebSocket connection.
   * If no URL is provided, uses the `remote-url` attribute.
   *
   * `options.failIfConnected` forwards an atomic ownership guard to
   * `AuthShell.connect()` — it rejects fast when another connection is
   * already open or a handshake is in flight, instead of closing the
   * other owner's socket. Used by `<auth0-session>` to close the
   * TOCTOU between its `auth.connected` check and this method's
   * `await connectedCallbackPromise` microtask hop
   * (SPEC-REMOTE §3.7 — Connection Ownership).
   */
  async connect(
    url?: string,
    options?: { failIfConnected?: boolean },
  ): Promise<ClientTransport> {
    await this._connectedCallbackPromise;
    return this._shell.connect(url || this.remoteUrl, options);
  }

  /**
   * In-band token refresh (§3.4.1). Sends a fresh token to the server
   * over the existing WebSocket. Core state is fully continuous.
   */
  async refreshToken(): Promise<void> {
    await this._connectedCallbackPromise;
    return this._shell.refreshToken();
  }

  /**
   * Refresh the token and establish a new WebSocket connection
   * (§3.4.2 — fallback for crash recovery).
   */
  async reconnect(): Promise<ClientTransport> {
    await this._connectedCallbackPromise;
    return this._shell.reconnect();
  }

  // --- Lifecycle ---

  connectedCallback(): void {
    this.style.display = "none";
    if (config.autoTrigger && !this._autoTriggerRegistered) {
      registerAutoTrigger();
      this._autoTriggerRegistered = true;
    }
    // Catch mode / remote-url changes that occurred while detached
    // (attributeChangedCallback bails on !isConnected).
    this._shell.mode = this.mode;
    this._warnIfRemoteWithoutAudience();
    this._tryInitialize();
  }

  attributeChangedCallback(_name: string, _oldValue: string | null, _newValue: string | null): void {
    if (!this.isConnected) return;

    // Keep the shell's mode in sync with the live attribute so that
    // token / getToken() / connect() honour post-init mode changes in
    // both directions (local→remote AND remote→local).
    //
    // We deliberately DO NOT re-run `initialize()` when `mode`,
    // `audience`, `scope`, `redirect-uri`, `cache-location`, or
    // `use-refresh-tokens` change post-init. The Auth0 SPA SDK owns
    // refresh-token / session storage keyed by those options; swapping
    // them mid-session would orphan the stored session and force a
    // silent-auth fallback. Applications that truly need to reconfigure
    // must tear down the element and mount a fresh one — `connect()` /
    // `reconnect()` will fail fast for a remote-mode mismatch
    // (missing audience) so the operator sees the mistake at the call
    // site rather than via a 1008 close.
    if (_name === "mode" || _name === "remote-url") {
      this._shell.mode = this.mode;
    }

    // Re-evaluate the remote-mode-without-audience warn whenever an
    // attribute that participates in the check changes. The latch
    // (`_remoteAudienceMissingWarned`) keeps this single-shot; calling
    // on every relevant change just ensures we catch a late-binding
    // framework that stamps `mode="remote"` BEFORE it stamps
    // `audience` (or vice-versa) — without re-evaluation the warn
    // would silently miss the case where `audience` is removed
    // post-init while staying in remote mode.
    if (_name === "mode" || _name === "remote-url" || _name === "audience") {
      this._warnIfRemoteWithoutAudience();
    }

    // `audience`, `scope`, `redirect-uri`, `cache-location`, and
    // `use-refresh-tokens` are all observed (so the browser delivers
    // mutations here) but the Auth0 SPA SDK is already constructed
    // with their original values — re-initialising would orphan the
    // cached session, and partial reconfiguration is not supported
    // by the SDK. Warn once per element on the FIRST post-init
    // mutation so the operator sees the silent inertness instead of
    // debugging a "the new value didn't take effect" mystery.
    //
    // `_oldValue !== null` skips the initial attribute landing
    // (oldValue null means "attribute first set", which IS observed
    // by the deferred-init microtask below); only post-init
    // mutations trigger the warn. A single one-shot covers the whole
    // group — five separate per-attribute warnings would be louder
    // than helpful, and the remediation is identical across them
    // (tear down and remount).
    //
    // The warn message also calls out `mode` / `remote-url` switches
    // even though those attributes ARE mirrored into the shell on
    // change: the shell mirror updates `_mode` and validates audience
    // at the next connect()/reconnect(), but the underlying Auth0 SDK
    // was constructed once with the original `cache-location` /
    // `use-refresh-tokens` / `audience`, so a `local`→`remote` flip
    // can leave the SDK partially misaligned with the new mode (e.g.
    // refresh tokens disabled when the remote mode actually needs
    // them, or vice versa). Mode switches are still legal — they just
    // share the same "tear down and remount for a clean reconfigure"
    // remediation as the inert-attribute mutations.
    if (
      _INERT_POST_INIT_ATTRIBUTES.includes(_name) &&
      _oldValue !== null &&
      _oldValue !== _newValue &&
      (this._shell.client || this._shell.initPromise) &&
      !this._postInitMutationWarned
    ) {
      this._postInitMutationWarned = true;
      console.warn(
        `${ERROR_PREFIX} <auth0-gate>: \`${_name}\` mutated after initialize() ` +
        `("${_oldValue}" -> "${_newValue}"). The Auth0 SPA SDK is constructed once ` +
        `with the initial values of \`audience\`, \`scope\`, \`redirect-uri\`, \`cache-location\`, ` +
        `and \`use-refresh-tokens\`; mid-life changes to any of these attributes are NOT ` +
        `applied to the existing client. Tear down and remount <auth0-gate> if you genuinely ` +
        `need to reconfigure. (connect()/reconnect() in remote mode still validates the live ` +
        `\`audience\` attribute against the server. Note: mutating \`mode\` or \`remote-url\` ` +
        `post-init updates the shell side but leaves the Auth0 SDK's \`cache-location\` / ` +
        `\`use-refresh-tokens\` / \`audience\` unchanged — verify the cached SDK options still ` +
        `match the new mode.)`,
      );
    }

    // Coalesce synchronous attribute stamps (frameworks that set domain,
    // client-id, cache-location, … in sequence) into a single init
    // attempt. Without the microtask, init fires as soon as domain +
    // client-id arrive, potentially before cache-location or
    // use-refresh-tokens are stamped.
    if (this._shell.client || this._shell.initPromise) return;
    if (this._initScheduled) return;
    this._initScheduled = true;
    this._connectedCallbackPromise = new Promise<void>((resolve) => {
      queueMicrotask(() => {
        this._initScheduled = false;
        if (
          !this.isConnected ||
          this._shell.client ||
          this._shell.initPromise ||
          !this.domain ||
          !this.clientId
        ) {
          resolve();
          return;
        }
        this.initialize().then(resolve, resolve);
      });
    });
  }

  /**
   * Emit a one-time `console.warn` when the element is configured for
   * remote mode but the `audience` attribute is missing or empty.
   *
   * Remote mode requires `audience` because the server's
   * `verifyAuth0Token` enforces an `aud` match and rejects the
   * handshake on mismatch. `connect()` / `reconnect()` already throw
   * synchronously on this misconfig, but elements that observe state
   * only (an "authenticating…" placeholder waiting for the main shell
   * to call connect()) never reach that path — the misconfig would
   * stay invisible until the application happens to attempt a
   * connection. Surfacing it during attribute resolution gives
   * integrators a dev-time signal at the original mistake site.
   *
   * Latched per-instance so attribute re-reads (frameworks that
   * re-stamp `mode` on every render) do not flood the console.
   */
  private _warnIfRemoteWithoutAudience(): void {
    if (this._remoteAudienceMissingWarned) return;
    if (this.mode !== "remote") return;
    if (this.audience) return;
    this._remoteAudienceMissingWarned = true;
    console.warn(
      `${ERROR_PREFIX} <auth0-gate>: remote mode is configured but \`audience\` is missing. ` +
      `Set the \`audience\` attribute to your API identifier — without it the server's ` +
      `verifyAuth0Token will reject the handshake on \`aud\` mismatch (close code 1008). ` +
      `connect() / reconnect() will throw at the call site, but observe-only elements ` +
      `(e.g. a "loading…" indicator) would otherwise not surface this until the first ` +
      `connection attempt.`,
    );
  }

  private _tryInitialize(): void {
    // Guard against double-init during the in-flight window.
    // `_shell.client` alone is not sufficient: it is set only after
    // `createAuth0Client()` resolves, so a disconnect→reconnect that
    // lands between `initialize()` start and that resolution would
    // see `client === null` and fire a second `initialize()`,
    // racing two `createAuth0Client()` calls and producing
    // nondeterministic state. Also checking `_shell.initPromise`
    // closes that window — the shell has already started, and
    // `_connectedCallbackPromise` still points at the first in-flight
    // promise so callers awaiting it see the same completion.
    if (
      !this._shell.client &&
      !this._shell.initPromise &&
      this.domain &&
      this.clientId
    ) {
      this._connectedCallbackPromise = this.initialize();
    }
  }

  disconnectedCallback(): void {
    // Balance the registerAutoTrigger() call from connectedCallback so
    // the global `document` click listener is detached once the last
    // <auth0-gate> instance leaves the DOM. Only unregister if THIS
    // instance actually registered — otherwise we would under-decrement
    // the refcount for an element whose connect happened while
    // `config.autoTrigger` was false.
    //
    // The autoTrigger unregister is intentionally synchronous (and
    // therefore asymmetric with the deferred WebSocket teardown
    // below): existing regression tests assert that
    // `document.removeEventListener("click", ...)` runs in the same
    // task as `el.remove()` once the last `<auth0-gate>` leaves the
    // DOM. The shared refcount in `autoTrigger.ts` makes
    // detach/reattach cheap (re-attach during the same task on
    // a portal move just bumps the count; only the very last leaver
    // calls `removeEventListener`), so the churn cost is bounded
    // even in rapid mount/unmount scenarios.
    if (this._autoTriggerRegistered) {
      unregisterAutoTrigger();
      this._autoTriggerRegistered = false;
    }
    // Release the remote session the element owns, but DEFER the
    // teardown one microtask so a same-task reconnect (React portal
    // move, framework reconciliation reinserting the node, route
    // transitions that preserve state) cancels it. Custom element
    // detach → reattach within the same task is common for hidden
    // controller elements; eager teardown here would drop the
    // authenticated WebSocket on every such hop and fire a spurious
    // `connected=false`. When the detach is a real removal (SPA route
    // change to a different view, conditional render), the element is
    // still disconnected by the time the microtask runs and we close
    // the socket to release the server-side session. The Auth0 SDK
    // itself is singleton and intentionally kept warm across mounts.
    queueMicrotask(() => {
      if (this.isConnected) return;
      this._shell.disconnect();
    });
  }
}
