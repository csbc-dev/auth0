import type { ClientTransport } from "@wc-bindable/remote";
import { createRemoteCoreProxy } from "@wc-bindable/remote";
import type { RemoteCoreProxy } from "@wc-bindable/remote";
import type { WcBindableDeclaration, UnbindFn } from "@wc-bindable/core";
import { bind, isWcBindable } from "@wc-bindable/core";
import { config } from "../config.js";
import { ERROR_PREFIX, OWNERSHIP_ERROR_MARKER, isOwnershipError } from "../raiseError.js";
import { IWcBindable } from "../types.js";
import { getCoreDeclaration } from "../coreRegistry.js";
import type { Auth } from "./Auth.js";

/**
 * `<auth0-session>` — declarative remote session gate.
 *
 * Pairs with a `<auth0-gate>` (referenced by `target` ID) and collapses
 * the three-stage readiness sequence (authenticated → WebSocket connected
 * → initial sync complete) into a single declarative signal.
 *
 * ## Core declaration source
 *
 * The Core's `wcBindable` declaration is sourced from one of two
 * places, in priority order:
 *
 *   1. **Child payload element (preferred)** — the first direct
 *      `HTMLElement` child whose constructor exposes a wc-bindable
 *      declaration (`isWcBindable(child) === true`). The session
 *      adopts that element as its data-plane facade: proxy property
 *      events are mirrored onto the child, declared command names are
 *      installed as forwarders that delegate to `proxy.invoke()`, and
 *      `data-wcs` / `bind(child, ...)` work directly against the child.
 *      The user owns the element class (and thus the schema) — there
 *      is no string registry indirection.
 *
 *   2. **Legacy `core` attribute + registry** — when no wc-bindable
 *      child is present and the `core` attribute is set, the session
 *      looks up the declaration via `getCoreDeclaration(this.core)`.
 *      The proxy is exposed as `.proxy` for applications that want to
 *      bind to it directly.
 *
 * When neither source is available, the session sets `error` and stops.
 * The `core` attribute and child payload are mutually exclusive: if a
 * wc-bindable child is found, the `core` attribute is ignored.
 *
 * ## Lifecycle
 *
 * When the target's `authenticated` goes `true`, the session:
 *   1. Calls `authEl.connect()` to open the authenticated WebSocket.
 *   2. Wraps the returned transport with `createRemoteCoreProxy()`.
 *   3. Subscribes via `bind()` and treats the first callback batch as
 *      "sync complete" — at that point `ready` flips to `true`. While
 *      streaming, each property update is mirrored onto the payload
 *      child (when present) so that `bind(child, ...)` and `data-wcs`
 *      observe a live state surface.
 *
 * The session's own bindable surface is intentionally minimal —
 * `ready`, `connecting`, `error` — so `data-wcs` can gate UI on
 * `ready` without applications having to re-implement "first batch"
 * detection.
 */
export class AuthSession extends HTMLElement {
  static hasConnectedCallbackPromise = true;

  static wcBindable: IWcBindable = {
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "ready",      event: "auth0-session:ready-changed" },
      { name: "connecting", event: "auth0-session:connecting-changed" },
      { name: "error",      event: "auth0-session:error" },
    ],
  };

  static get observedAttributes(): string[] {
    return ["target", "core", "url", "auto-connect"];
  }

  private _ready = false;
  private _connecting = false;
  private _error: Error | null = null;
  private _proxy: RemoteCoreProxy | null = null;
  private _transport: ClientTransport | null = null;
  private _unbind: UnbindFn | null = null;
  private _authEl: Auth | null = null;
  private _coreDecl: WcBindableDeclaration | null = null;
  private _payload: HTMLElement | null = null;
  // Tracks property and command names installed as own-properties on
  // `_payload` during the active session, so `_teardownProxy` can
  // remove only what we added (and not blast over user-set props).
  private _payloadInstalledProps: string[] = [];
  private _payloadInstalledCmds: Array<{ name: string; forwarder: (...args: unknown[]) => unknown }> = [];
  private _authListener: ((e: Event) => void) | null = null;
  private _connectedListener: ((e: Event) => void) | null = null;
  private _connectedCallbackPromise: Promise<void> = Promise.resolve();
  // Coalesce bursts of attribute changes (frameworks often stamp
  // target/core/url/auto-connect in quick succession) into a single
  // `_startWatching()` run.
  private _attrRestartScheduled = false;

  // Monotonic counter incremented on every teardown (logout listener or
  // disconnectedCallback). `_connect()` captures the value at entry and
  // discards its own work — including the just-opened transport and any
  // in-flight "first sync batch" microtask — if the counter has moved
  // forward by the time an `await` resolves. Without this, a handshake
  // that completes AFTER logout/remove would still install a live proxy
  // and flip `ready=true`.
  private _generation = 0;

  // --- Attributes -----------------------------------------------------------

  get target(): string {
    return this.getAttribute("target") || "";
  }

  set target(value: string) {
    this.setAttribute("target", value);
  }

  get core(): string {
    return this.getAttribute("core") || "";
  }

  set core(value: string) {
    this.setAttribute("core", value);
  }

  /**
   * Optional URL override. Falls back to the target `<auth0-gate>`'s `remote-url`.
   *
   * Read once per `_startWatching()` cycle (in `_connect()`). Dynamic
   * changes to either this attribute OR the target's `remote-url`
   * AFTER the session has an open transport are NOT observed —
   * `attributeChangedCallback` re-runs `_startWatching()` only while
   * the session is idle (`!_transport && !_connecting`). Set the URL
   * before the session connects, or tear down (logout / removal) and
   * remount with the new value, or call `start()` manually after the
   * change.
   */
  get url(): string {
    return this.getAttribute("url") || "";
  }

  set url(value: string) {
    this.setAttribute("url", value);
  }

  /** Whether to auto-connect when the target becomes authenticated (default true). */
  get autoConnect(): boolean {
    const v = this.getAttribute("auto-connect");
    return v === null ? true : v !== "false";
  }

  set autoConnect(value: boolean) {
    this.setAttribute("auto-connect", value ? "true" : "false");
  }

  // --- Output state (bindable) ---------------------------------------------

  /** `true` once the first post-sync batch of proxy values has been delivered. */
  get ready(): boolean {
    return this._ready;
  }

  /** `true` between `connect()` start and either `ready` or `error`. */
  get connecting(): boolean {
    return this._connecting;
  }

  get error(): Error | null {
    return this._error;
  }

  // --- JS-only accessors ---------------------------------------------------

  /**
   * The `RemoteCoreProxy` once built. Applications bind to this directly.
   *
   * Lifecycle:
   *   - `null` before the first successful `_connect()` completes.
   *   - Points at a live proxy once the WebSocket handshake resolves
   *     and `createRemoteCoreProxy` wires the transport. The switch
   *     happens BEFORE `ready` flips true (`ready` waits for the
   *     first sync batch; `proxy` becomes reachable as soon as the
   *     transport is installed).
   *   - Returns to `null` on teardown (logout, element removal,
   *     auth-revoked, transport close). A teardown that races a
   *     pending handshake yields `proxy === null` forever for that
   *     handshake — the generation guard drops the late arrival.
   */
  get proxy(): RemoteCoreProxy | null {
    return this._proxy;
  }

  /**
   * The `ClientTransport` underlying `proxy`, exposed for applications
   * that need direct access (e.g. sending raw commands alongside
   * proxy-bound state). Same lifecycle as `proxy` — the pair is
   * installed and cleared atomically.
   */
  get transport(): ClientTransport | null {
    return this._transport;
  }

  /**
   * The wc-bindable child element adopted as the data-plane facade,
   * or `null` when the session is using the legacy registry path
   * (`core="..."` + `registerCoreDeclaration`) or has not yet started.
   *
   * Same lifecycle as `proxy`: set once `_startWatching` discovers a
   * matching child, cleared on teardown.
   */
  get payload(): HTMLElement | null {
    return this._payload;
  }

  /**
   * Resolves once the initial `_startWatching()` cycle settles.
   *
   * Limitation: when `auto-connect="false"` the session does not
   * auto-start, so `connectedCallbackPromise` keeps the
   * already-resolved initial value and does NOT track the lifecycle
   * of any subsequent imperative `start()` call. Applications that
   * drive the session via `start()` should `await start()` directly —
   * the promise read from this property at startup will not reflect
   * the imperative cycle's progress. This also applies when
   * `auto-connect` is flipped from `false` to `true` mid-life: a
   * caller that cached the promise BEFORE the flip is left awaiting
   * the original (already-resolved) promise and misses the second
   * start. Re-read `connectedCallbackPromise` after any deliberate
   * mid-life restart to pick up the fresh promise.
   */
  get connectedCallbackPromise(): Promise<void> {
    return this._connectedCallbackPromise;
  }

  // --- Lifecycle ------------------------------------------------------------

  connectedCallback(): void {
    this.style.display = "none";
    if (this.autoConnect) {
      // Defer so sibling elements (notably the target `<auth0-gate>`) can
      // finish upgrading before we resolve them by ID.
      this._connectedCallbackPromise = new Promise<void>((resolve) => {
        queueMicrotask(() => {
          this._startWatching().finally(resolve);
        });
      });
    }
    // NB: when `autoConnect` is false, `_connectedCallbackPromise`
    // keeps the already-resolved initial value. Applications that
    // drive the session imperatively via `start()` observe the
    // watching lifecycle through the returned promise from that
    // call; `connectedCallbackPromise` deliberately does not block
    // on a session that may never be started.
  }

  disconnectedCallback(): void {
    this._teardown();
    // `_unsubscribeAuth()` now clears `_authEl` as part of its
    // teardown, so the explicit assignment that used to follow
    // (kept for the redundant clear) is no longer needed.
    this._unsubscribeAuth();
  }

  attributeChangedCallback(_name: string, _oldValue: string | null, _newValue: string | null): void {
    // Framework / declarative integrations that stamp target/core/url
    // AFTER the element is connected (or flip auto-connect from false to
    // true) would otherwise be stuck with whatever value `_startWatching`
    // saw on the very first pass. Restart only when it is safe —
    // i.e. no live transport or in-flight connect — and coalesce bursts
    // of attribute mutations into a single restart via microtask.
    if (!this.isConnected) return;
    if (!this.autoConnect) return;
    if (this._transport || this._connecting) return;
    if (this._attrRestartScheduled) return;
    this._attrRestartScheduled = true;
    queueMicrotask(() => {
      this._attrRestartScheduled = false;
      if (!this.isConnected) return;
      if (!this.autoConnect) return;
      if (this._transport || this._connecting) return;
      this._connectedCallbackPromise = this._startWatching();
    });
  }

  // --- Public imperative API ------------------------------------------------

  /**
   * Manually start (or restart) the session.
   *
   * Public re-entrant API: calling `start()` on an already-started
   * session is supported and triggers a clean restart. The
   * implementation is `_startWatching()`, which begins by tearing
   * down any previous cycle (`_unsubscribeAuth()` + `_teardown()`)
   * and bumping the generation counter — so any in-flight handshake
   * from the previous cycle drops its work on resume via the
   * generation guards in `_connect()`.
   *
   * Use cases:
   *
   *   - **`auto-connect="false"`**: nothing happens automatically;
   *     call `start()` once when the application is ready to open
   *     the session.
   *   - **Mid-life target / core / url change**: `attributeChangedCallback`
   *     coalesces attribute-driven restarts via a microtask, but only
   *     while the session is idle (`!_transport && !_connecting`). To
   *     restart after a transport is established (e.g. switching
   *     `target` to a different `<auth0-gate>`), call `start()`
   *     explicitly — the implicit auto-restart deliberately does NOT
   *     interrupt a live session.
   *   - **Recovery after an error**: a session that ended in
   *     `error` state stays inert until either an attribute mutation
   *     (which the auto-restart picks up while idle) or an explicit
   *     `start()` call. Use `start()` for application-driven retry
   *     loops.
   *   - **`auto-connect` flipped from `false` to `true`**: the
   *     attribute change is observed but does not trigger an
   *     auto-start (that path runs only inside `connectedCallback`).
   *     Call `start()` after the flip.
   *
   * `connectedCallbackPromise` does NOT track imperative `start()`
   * cycles — `await start()` directly when you need to await the
   * imperative startup. See the `connectedCallbackPromise` JSDoc for
   * the rationale.
   */
  async start(): Promise<void> {
    return this._startWatching();
  }

  // --- Private --------------------------------------------------------------

  private async _startWatching(): Promise<void> {
    // Cancel any previous cycle (auto-connect that already ran, or an
    // earlier start() call). Without these resets a re-start would leak
    // the prior authenticated-changed listener — `disconnectedCallback`
    // can only remove the most recently stored one — and any in-flight
    // `_connect` from the previous cycle would race with the new one.
    this._unsubscribeAuth();
    this._teardown();
    // Preserve a standing Connection Ownership violation (SPEC-REMOTE
    // §3.7 "surfaces the mistake immediately") across auto-restarts
    // triggered by attributeChangedCallback's microtask coalescer.
    // Without this guard, a framework that re-stamps target / core /
    // url after the initial run would restart `_startWatching`, hit
    // `_setError(null)` here, and wipe the just-shown ownership
    // warning one microtask after it appeared — so the developer
    // never sees the mistake even though the underlying misconfig
    // is still present. If ownership later clears (owner disconnects,
    // config changes, etc.), `_connect` will either succeed or reset
    // to a different error via its own `_setError` calls.
    //
    // Uses the stable `_authOwnership` sentinel property via
    // `isOwnershipError()` rather than a message-substring match.
    // The message wording can drift across refactors; the sentinel
    // is the API contract the producers (`raiseOwnershipError()` in
    // AuthShell, the `_connect` construction below) explicitly opt
    // into.
    //
    // Precedence rule: a standing ownership error WINS over any new
    // restart's natural error clear, even when the restart was
    // triggered by a mutation to `target` / `core` / `url` that was
    // intended to FIX the ownership conflict. This is deliberate —
    // the ownership condition is re-evaluated synchronously by
    // `_connect()` below, which calls `_setError(null)` on its own
    // happy path and `_setError(ownershipErr)` on the still-violating
    // path. So a corrected configuration clears the message in the
    // same `_startWatching()` run; the only wording that lingers is
    // for genuinely unresolved ownership violations. Applications
    // that want the standing error cleared explicitly on attribute
    // change should call `start()` after manually setting `error =
    // null` (which the public surface does not currently expose, by
    // design — see `_setError`'s identity-comparison rationale).
    const standingOwnershipError = isOwnershipError(this._error) ? this._error : null;
    if (!standingOwnershipError) this._setError(null);

    // Capture generation AFTER teardown so this run is the active one.
    // A subsequent teardown / start() will move it forward and the
    // generation guards below abort this run cleanly.
    const myGen = this._generation;

    const auth = this._resolveAuth();
    if (!auth) {
      this._setError(new Error(`${ERROR_PREFIX} <auth0-session>: target "${this.target}" not found.`));
      return;
    }
    this._authEl = auth;

    // Discovery — child payload element (preferred) takes priority over the
    // legacy `core` attribute + registry path. The session adopts the first
    // direct child whose constructor declares `wcBindable`; users own the
    // schema by defining the element class once.
    //
    // The discovery returns synchronously when every candidate child is
    // already upgraded (or there are none). When at least one
    // custom-element child is still unupgraded, it returns a Promise that
    // awaits `customElements.whenDefined()` — covering a script-load
    // order quirk (auth0-session defined before the user's element)
    // without paying an unconditional microtask tick on the legacy
    // `core` + registry path.
    const discovered = this._resolvePayloadChild();
    let childPayload: HTMLElement | null;
    if (discovered instanceof Promise) {
      childPayload = await discovered;
      if (this._generation !== myGen) return;
    } else {
      childPayload = discovered;
    }

    let decl: WcBindableDeclaration | null = null;
    if (childPayload) {
      decl = (childPayload.constructor as unknown as { wcBindable?: WcBindableDeclaration }).wcBindable ?? null;
      if (!decl) {
        // isWcBindable returned true a moment ago, so this is paranoia —
        // but a malformed declaration that lost its protocol/version
        // tags between discovery and read should not silently produce
        // an unhandled crash later.
        this._setError(new Error(
          `${ERROR_PREFIX} <auth0-session>: payload child <${childPayload.localName}> has no wcBindable declaration.`,
        ));
        return;
      }
      this._payload = childPayload;
    } else {
      const coreKey = this.core;
      if (!coreKey) {
        this._setError(new Error(
          `${ERROR_PREFIX} <auth0-session>: no payload source. Either nest a wc-bindable child element inside <auth0-session>, ` +
          "or set the `core` attribute and call registerCoreDeclaration() at bootstrap.",
        ));
        return;
      }
      const decl0 = getCoreDeclaration(coreKey);
      if (!decl0) {
        this._setError(new Error(`${ERROR_PREFIX} <auth0-session>: core "${coreKey}" is not registered. Call registerCoreDeclaration("${coreKey}", decl) first.`));
        return;
      }
      decl = decl0;
    }
    this._coreDecl = decl;

    // Wait for the target to finish initialization (handleRedirectCallback,
    // isAuthenticated probe, etc.) so `auth.authenticated` is settled.
    await auth.connectedCallbackPromise;

    // A concurrent start() / teardown() may have superseded this run while
    // we awaited. Bail before installing a listener that the active run
    // will not be able to remove.
    if (this._generation !== myGen) return;

    // Subscribe to future authenticated-changed events before the current
    // check so we don't miss a near-simultaneous transition.
    const listener = (e: Event): void => {
      const next = (e as CustomEvent).detail;
      if (next === true) {
        void this._connect();
      } else {
        this._teardown();
      }
    };
    this._authListener = listener;
    auth.addEventListener("auth0-gate:authenticated-changed", listener);

    // Notice transport loss. The WebSocket can die independently of
    // Auth0 authentication — server-forced close at token expiry
    // (4401 "Session expired"), `sub` mismatch on refresh (4403),
    // server restart, transient network blip, or a post-upgrade 1008
    // (exp-parse-failure under "close" policy) — in which case
    // AuthShell dispatches `connected-changed: false` but the Auth0
    // SDK's `authenticated` stays true. Without this listener, `ready`
    // would linger at `true` pointing at a dead proxy whose next call
    // rejects with `_disposedError`.
    //
    // `_teardown()` (rather than a manual partial clear) is used so
    // that `_generation` is bumped. That bump is what lets an
    // in-flight `_connect()` — which may have ALREADY resolved its
    // `await auth.connect(...)` on `open` but not yet resumed — see
    // a generation mismatch on resume and skip installing its
    // (already-dead) transport. A manual clear without a generation
    // bump would silently let the resumed `_connect()` wire a
    // `RemoteCoreProxy` onto the closed socket, leaving a
    // half-dead session in `ready=true`.
    const connectedListener = (e: Event): void => {
      const next = (e as CustomEvent).detail;
      if (next === false && (this._transport || this._ready || this._connecting)) {
        this._teardown();
      }
    };
    this._connectedListener = connectedListener;
    auth.addEventListener("auth0-gate:connected-changed", connectedListener);

    if (auth.authenticated) {
      await this._connect();
    }
  }

  private _unsubscribeAuth(): void {
    if (this._authEl && this._authListener) {
      this._authEl.removeEventListener("auth0-gate:authenticated-changed", this._authListener);
    }
    if (this._authEl && this._connectedListener) {
      this._authEl.removeEventListener("auth0-gate:connected-changed", this._connectedListener);
    }
    this._authListener = null;
    this._connectedListener = null;
    // Clear `_authEl` so any subsequent `_startWatching()` re-runs
    // `_resolveAuth()` from a clean slate. `_resolveAuth()` always
    // re-fetches by current `target` attribute anyway, so retaining a
    // stale reference here served no purpose — and crucially, leaking
    // a reference to a possibly-removed Auth element across teardowns
    // could keep that element reachable from this session past its
    // intended lifetime. `disconnectedCallback` already does this for
    // the disconnect path; making it consistent across all teardown
    // paths simplifies the lifecycle invariant.
    this._authEl = null;
  }

  private async _connect(): Promise<void> {
    if (this._transport || this._connecting) return;
    const auth = this._authEl;
    const decl = this._coreDecl;
    if (!auth || !decl) return;

    // Mutual-exclusion guard (SPEC-REMOTE §3.7). If the target already has
    // an open WebSocket, someone else — typically application code calling
    // authEl.connect() directly — owns the transport. We cannot bind a
    // proxy to a transport we did not create, and calling connect() again
    // would close theirs. Fail visibly instead of producing a silently
    // dead session.
    //
    // Tag the Error with `_authOwnership = true` so `_startWatching`'s
    // standing-error preservation recognises it on the stable sentinel
    // rather than a message-substring match. The sentinel is the same
    // one `raiseOwnershipError()` stamps on AuthShell-originated
    // ownership failures; both sources funnel into `isOwnershipError()`.
    if (auth.connected) {
      const ownershipErr = new Error(
        `${ERROR_PREFIX} <auth0-session>: target is already connected. ` +
        "Use either <auth0-session> OR a manual authEl.connect() — not both. " +
        "See SPEC-REMOTE §3.7 (Connection Ownership).",
      );
      (ownershipErr as unknown as Record<string, boolean>)[OWNERSHIP_ERROR_MARKER] = true;
      this._setError(ownershipErr);
      return;
    }

    // URL contract: either the session's own `url` attribute or the
    // target's `remote-url` must resolve to a non-empty string. Validating
    // here surfaces a friendly, contract-named error before any work is
    // done; without it the empty string flows into AuthShell.connect()
    // and ultimately to `new WebSocket("")`, which produces an opaque
    // SyntaxError that doesn't tell the integrator which attribute to set.
    const url = this.url || auth.remoteUrl;
    if (!url) {
      this._setError(new Error(
        `${ERROR_PREFIX} <auth0-session>: no WebSocket URL configured. ` +
        "Set the `url` attribute on <auth0-session> or `remote-url` on the target <auth0-gate>.",
      ));
      return;
    }

    this._setError(null);
    this._setConnecting(true);
    const myGen = this._generation;
    try {
      // Pass `failIfConnected: true` so AuthShell.connect() atomically
      // rejects when another owner claimed the transport during the
      // `await connectedCallbackPromise` microtask hop inside
      // Auth.connect(). Without this flag the outer `auth.connected`
      // fast-path check (above) has a TOCTOU: a concurrent caller
      // could open a socket between the check and this call, and the
      // subsequent AuthShell.connect() would `_closeWebSocket()` it,
      // violating the Connection Ownership contract (SPEC-REMOTE §3.7).
      const transport = await auth.connect(url, { failIfConnected: true });

      // Race guard: a teardown (logout, element removal, or a
      // `connected-changed: false` that fired AFTER `auth.connect`
      // resolved but BEFORE this microtask resumed) moved the
      // generation forward while we were awaiting. That covers both:
      //   (a) the explicit `_teardown()` paths (logout /
      //       disconnectedCallback / authenticated flipping false),
      //   (b) the server closing the freshly-opened socket with 1008
      //       between `open` and our resume — e.g. exp-parse-failure
      //       under "close" policy, or the defense-in-depth origin
      //       close in `wss.on("connection")` — where our
      //       `connected-changed` listener bumps the generation so
      //       this guard trips and we never wire a `RemoteCoreProxy`
      //       onto a dead socket.
      if (this._generation !== myGen) return;

      this._transport = transport;

      const proxy = createRemoteCoreProxy(decl, transport);
      this._proxy = proxy;

      // Install command forwarders on the payload child up-front, before
      // the first sync arrives. Sync timing is server-driven, but commands
      // can be invoked the moment the transport is open — installing here
      // rather than from inside the bind callback makes `payload.cmd(...)`
      // available as soon as `proxy` is set, not just after the first
      // property event.
      if (this._payload) this._installPayloadCommandForwarders(this._payload, proxy, decl);

      // First bind callback = first event from the proxy's `sync` handler.
      // `queueMicrotask` defers the ready flip to after the whole batch of
      // initial property events has been dispatched — matching the pattern
      // in SPEC-REMOTE §11 and freeing applications from implementing it.
      // The generation check covers a teardown that lands between bind()
      // registration and the first dispatched event.
      //
      // Capture the unbind function in a local BEFORE assigning to
      // `this._unbind`. `@wc-bindable/core`'s `bind()` may invoke its
      // callback synchronously during registration (e.g. when the proxy
      // already has cached initial values to deliver). If a teardown
      // lands inside that synchronous callback — via `_setReady(true)`
      // dispatching `ready-changed` and an external listener calling
      // `_teardown()` re-entrantly — `_teardownProxy()` would observe
      // `this._unbind === null` (we have not yet returned from bind())
      // and skip disposal, leaving the bind callback wired against the
      // dead proxy. Local-variable capture lets us fall back to the
      // local reference if `_teardownProxy()` runs synchronously inside
      // bind(), so the disposer is never lost.
      //
      // The generation guard inside the callback already prevents
      // `_setReady(true)` from firing under a stale generation, so
      // there is no observable misbehaviour TODAY — this is
      // defense-in-depth against a future refactor that introduces a
      // synchronous teardown path between bind() entry and assignment.
      let firstBatch = true;
      let myUnbind: UnbindFn | null = null;
      myUnbind = bind(proxy, (name, value) => {
        // Mirror property updates onto the payload child so that
        // `bind(payload, ...)` and `data-wcs="prop: ..."` observe a
        // live state surface without applications having to bridge
        // the proxy themselves.
        //
        // The mirror writes BEFORE re-dispatching the event so that
        // any listener registered on the payload (including @wc-bindable's
        // own `bind()`) reads the up-to-date value when it inspects
        // `payload[name]` after receiving the dispatch.
        if (this._payload && this._proxy === proxy && this._generation === myGen) {
          this._mirrorToPayload(this._payload, decl, name, value);
        }

        if (firstBatch) {
          firstBatch = false;
          queueMicrotask(() => {
            if (this._proxy === proxy && this._generation === myGen) {
              this._setReady(true);
            }
          });
        }
      });
      // If `_teardown()` ran synchronously inside bind(), the proxy is
      // already gone but `myUnbind` is still live — call it directly so
      // the bind callback is not orphaned, and skip the assignment to
      // `this._unbind` (the next teardown would otherwise re-call a
      // disposer that has already fired, which `@wc-bindable/core`
      // tolerates today but the contract does not formally guarantee).
      if (this._proxy !== proxy || this._generation !== myGen) {
        myUnbind?.();
        return;
      }
      this._unbind = myUnbind;
    } catch (err) {
      // Swallow errors from a superseded attempt — reporting them would
      // clobber state the active teardown has already reset.
      if (this._generation !== myGen) return;
      this._setError(err instanceof Error ? err : new Error(String(err)));
      this._teardownProxy();
    } finally {
      // Only clear `connecting` if our generation is still active.
      // A teardown that fired during the await already flipped it to
      // false; stepping on that would produce a spurious false→true→false
      // transition for listeners.
      if (this._generation === myGen) this._setConnecting(false);
    }
  }

  private _teardown(): void {
    // Bumping the generation invalidates any in-flight `_connect()`:
    // the handshake it is awaiting may still resolve, but the race
    // guards in `_connect` will see a mismatched generation and drop
    // the work on the floor.
    this._generation++;
    this._teardownProxy();
    if (this._ready) this._setReady(false);
    if (this._connecting) this._setConnecting(false);
  }

  private _teardownProxy(): void {
    if (this._unbind) {
      this._unbind();
      this._unbind = null;
    }
    // Restore the payload child to the state it had before adoption.
    // Removes only the own-properties WE installed (mirrored values and
    // command forwarders); user-defined own-properties or prototype
    // members are left untouched. Cleanup runs even when `_proxy` /
    // `_transport` are already null because we may have installed
    // command forwarders before the first sync.
    this._uninstallPayloadForwarders();
    this._payload = null;
    // NB: we do NOT close the transport here — the transport is owned by
    // AuthShell (via logout() or reconnect()). Dropping our reference is
    // enough; the underlying WebSocket is managed by the auth element.
    this._proxy = null;
    this._transport = null;
  }

  /**
   * Find a direct child element that exposes a wc-bindable declaration
   * on its constructor.
   *
   * Returns synchronously (the resolved value, possibly `null`) when
   * every custom-element child is already upgraded — preserving
   * exact microtask ordering for the legacy `core` + registry path,
   * which is timing-sensitive in regression tests for in-flight
   * teardown races.
   *
   * Returns a `Promise<HTMLElement | null>` only when at least one
   * candidate child is an unupgraded custom element; the promise
   * awaits `customElements.whenDefined` so a script-load order
   * mismatch (auth0-session defined before the user's element class)
   * does not produce a spurious "no payload" error.
   *
   * Tie-breaking differs between the two branches:
   *
   *   - **Sync branch**: strict DOM order — the first child for which
   *     `isWcBindable` is true wins.
   *   - **Async branch**: first wc-bindable *settler* wins, not strict
   *     DOM order. A faster upgrade outranks a slower one. This trade
   *     is deliberate so a perpetually-undefined sibling earlier in DOM
   *     order does not deadlock discovery; see `_resolvePayloadChildAsync`
   *     for the full rationale.
   *
   * Either way, only one child is adopted — SPEC-REMOTE §3.7 caps the
   * connection at one proxy per session.
   */
  private _resolvePayloadChild(): HTMLElement | null | Promise<HTMLElement | null> {
    let needsAsync = false;
    for (const child of Array.from(this.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (isWcBindable(child)) return child;
      const tag = child.localName;
      if (tag.includes("-") && !customElements.get(tag)) {
        needsAsync = true;
      }
    }
    if (!needsAsync) return null;
    return this._resolvePayloadChildAsync();
  }

  private _resolvePayloadChildAsync(): Promise<HTMLElement | null> {
    // Wait for all candidates IN PARALLEL — never sequentially. A single
    // unrelated unupgraded child (e.g. a typo'd or experimental
    // `<unknown-widget>`) earlier in DOM order would otherwise block
    // `customElements.whenDefined()` forever (the spec never rejects),
    // pinning `connectedCallbackPromise` and starving the legacy-core
    // fallback. Race the lot and resolve as soon as any candidate
    // upgrades into a wc-bindable element.
    //
    // Resolution rules:
    //   - First wc-bindable settler wins (NOT strict DOM order — a faster
    //     upgrade outranks a slower one, which mirrors the practical
    //     "earliest registered first" reality of script-driven defines).
    //   - When every candidate has settled into a non-wc-bindable state
    //     (or there are no candidates at all), resolve `null` so the
    //     legacy `core` + registry path can run.
    //   - When some candidates remain pending forever (defined-element
    //     name nobody ever registers), the promise keeps waiting. This
    //     is the unavoidable corner where "wait for upgrade" semantics
    //     and "give up cleanly" semantics conflict — see SPEC-REMOTE
    //     §3.7 for why we accept the stall over silently dropping a
    //     payload that may legitimately upgrade later.
    const candidates: HTMLElement[] = [];
    for (const child of Array.from(this.children)) {
      if (child instanceof HTMLElement) candidates.push(child);
    }
    return new Promise<HTMLElement | null>((resolve) => {
      if (candidates.length === 0) { resolve(null); return; }
      let pending = candidates.length;
      let settled = false;
      const win = (value: HTMLElement | null): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const finish = (child: HTMLElement): void => {
        if (settled) return;
        if (isWcBindable(child)) { win(child); return; }
        if (--pending === 0) win(null);
      };
      for (const child of candidates) {
        const tag = child.localName;
        const isCustom = tag.includes("-");
        // Already-upgraded (or non-custom) children resolve synchronously
        // through the same `finish()` accounting so a mixed batch — some
        // upgraded, some pending — converges correctly.
        if (!isCustom || customElements.get(tag)) {
          finish(child);
          continue;
        }
        customElements.whenDefined(tag).then(
          () => finish(child),
          () => {
            // whenDefined() does not reject in the spec, but defensively
            // treat any failure as "this candidate is out of the running"
            // so the pending counter still drains.
            if (settled) return;
            if (--pending === 0) win(null);
          },
        );
      }
    });
  }

  /**
   * Mirror a single property update onto the payload child:
   *   - install / overwrite an own data property `child[name] = value`
   *   - re-dispatch the user's declared event on the child
   *
   * The own-property is configurable+writable so the next teardown can
   * `delete` it to leave the child in a pristine state, and so a
   * subsequent value can replace it without the noisy
   * defineProperty-twice warning some engines emit on identical descriptors.
   */
  private _mirrorToPayload(
    payload: HTMLElement,
    decl: WcBindableDeclaration,
    name: string,
    value: unknown,
  ): void {
    Object.defineProperty(payload, name, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    if (this._payloadInstalledProps.indexOf(name) === -1) {
      this._payloadInstalledProps.push(name);
    }
    const prop = decl.properties.find((p) => p.name === name);
    if (!prop) return;
    payload.dispatchEvent(new CustomEvent(prop.event, { detail: value, bubbles: true }));
  }

  /**
   * Install one own-property forwarder per declared command.
   *
   * `payload.increment(...args)` ends up calling
   * `proxy.invoke("increment", ...args)`, returning the proxy's promise
   * so callers can `await` for the server's `return` frame. The
   * forwarder uses the captured `proxy` reference rather than reading
   * `this._proxy` so that a teardown that races a pending invocation
   * still routes the call to the correct (now-disposed) proxy — which
   * rejects with `_disposedError` rather than silently dropping the
   * command.
   *
   * If the user's element class already defines the same name on its
   * prototype, our forwarder shadows it via an own-property assignment
   * for the duration of the session; teardown deletes the own-property
   * so prototype lookup falls back to the user's method.
   */
  private _installPayloadCommandForwarders(
    payload: HTMLElement,
    proxy: RemoteCoreProxy,
    decl: WcBindableDeclaration,
  ): void {
    const cmds = decl.commands;
    if (!cmds) return;
    for (const cmd of cmds) {
      const name = cmd.name;
      const forwarder = (...args: unknown[]) => proxy.invoke(name, ...args);
      Object.defineProperty(payload, name, {
        value: forwarder,
        writable: true,
        configurable: true,
        enumerable: false,
      });
      this._payloadInstalledCmds.push({ name, forwarder });
    }
  }

  private _uninstallPayloadForwarders(): void {
    const payload = this._payload;
    if (!payload) {
      this._payloadInstalledProps.length = 0;
      this._payloadInstalledCmds.length = 0;
      return;
    }
    // Property mirrors — delete every name we installed (no identity
    // check). Mirrored values are generic primitives (numbers, strings,
    // user objects), so an identity check would be unreliable: a user
    // who writes `payload.count = 5` between two server pushes that
    // also report `5` would be treated as "still our value" and deleted
    // anyway, while a user who happens to write a freshly-allocated
    // object identical in shape to ours would be incorrectly preserved.
    // The cleaner semantics are "session ends → mirror is reset to the
    // pre-adoption state"; if a user wants to preserve their own value
    // across teardown they can re-define the property after `error` /
    // `ready=false` fires.
    for (const propName of this._payloadInstalledProps) {
      const desc = Object.getOwnPropertyDescriptor(payload, propName);
      if (desc && desc.configurable) {
        try { delete (payload as unknown as Record<string, unknown>)[propName]; } catch { /* noop */ }
      }
    }
    this._payloadInstalledProps.length = 0;

    // Command forwarders, by contrast, ARE compared by reference — each
    // session installs a fresh closure (`(...args) => proxy.invoke(...)`)
    // unique to that proxy instance, so identity is meaningful: a user
    // who replaced the method with their own function never collides
    // with our captured forwarder, and we only undo our own writes.
    for (const { name, forwarder } of this._payloadInstalledCmds) {
      const desc = Object.getOwnPropertyDescriptor(payload, name);
      if (desc && desc.configurable && desc.value === forwarder) {
        try { delete (payload as unknown as Record<string, unknown>)[name]; } catch { /* noop */ }
      }
    }
    this._payloadInstalledCmds.length = 0;
  }

  /**
   * Resolve the target `<auth0-gate>` by ID.
   *
   * Limitation: uses `document.getElementById`, which only walks the
   * main document tree. A `<auth0-session>` placed inside a Shadow DOM
   * tree cannot resolve a target that lives in a different shadow root
   * — applications composing across shadow boundaries should keep both
   * elements in the same tree, or set `.target` programmatically to a
   * pre-resolved `<auth0-gate>` element via a wrapper that exposes the
   * looked-up node. (Unlike `<auth0-logout>`, `<auth0-session>` always
   * requires an explicit `target` ID, so there is no `closest()` /
   * `querySelector` fallback path.)
   */
  private _resolveAuth(): Auth | null {
    if (!this.target) return null;
    const el = document.getElementById(this.target);
    if (el && el.tagName.toLowerCase() === config.tagNames.auth) {
      // A node that carries the right tag name but has not yet
      // upgraded (script still loading, custom element registry
      // race) has no `connect` / `logout` methods; calling
      // `.connect(...)` would throw a TypeError during connect().
      // Mirror `<auth0-logout>`'s guard — return null when the
      // element has not yet upgraded so the caller hits the friendly
      // "target not found" error path instead of crashing.
      return _isAuth(el) ? (el as unknown as Auth) : null;
    }
    return null;
  }

  private _setReady(value: boolean): void {
    if (this._ready === value) return;
    this._ready = value;
    this.dispatchEvent(new CustomEvent("auth0-session:ready-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  private _setConnecting(value: boolean): void {
    if (this._connecting === value) return;
    this._connecting = value;
    this.dispatchEvent(new CustomEvent("auth0-session:connecting-changed", {
      detail: value,
      bubbles: true,
    }));
  }

  /**
   * Update the session's error state and dispatch `error` when the
   * value actually changes. The comparison is reference equality —
   * deliberate, not a bug:
   *
   *   - The main caller pattern is `_setError(null)` at `_connect()`
   *     start, then `_setError(err)` on failure. Reference equality
   *     of `null === null` suppresses the redundant "clear" event
   *     when the session starts from an already-clear state,
   *     without ever suppressing a real error→error transition
   *     (two different Error instances, even with the same
   *     message, compare unequal).
   *
   * **Limitation: same-instance double-call is silently coalesced.**
   *
   * The `null === null` suppression above is the load-bearing case;
   * the same predicate also coalesces "same Error instance set
   * twice" but that is a side effect, not a contract. If a future
   * caller path captures one `Error` reference and passes it through
   * `_setError` twice (e.g. an exception caught at the outer try and
   * re-set after a retry that also fails with the same captured
   * reference), the second call is dropped silently and subscribers
   * never see a "the error is still here" signal. Current callers
   * always allocate a fresh `Error` per failure, so this is theoretical
   * — but a future refactor that introduces error capture-and-replay
   * needs to either allocate a wrapper Error or reset
   * `this._error = null` between calls. Single-call paths and
   * legitimate error→error transitions across distinct Error
   * instances are unaffected.
   */
  private _setError(value: Error | null): void {
    if (this._error === value) return;
    this._error = value;
    this.dispatchEvent(new CustomEvent("auth0-session:error", {
      detail: value,
      bubbles: true,
    }));
  }
}

/**
 * Duck-type guard: treat an element as an upgraded `<auth0-gate>`
 * only once its `connect` method is a callable function. Mirrors the
 * helper in `AuthLogout` — keeps a freshly-parsed-but-not-yet-
 * upgraded custom element from being passed to `_connect()`, which
 * would crash on the missing method.
 */
function _isAuth(el: Element): boolean {
  return typeof (el as unknown as { connect?: unknown }).connect === "function";
}
