import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";

import { AuthSession } from "../src/components/AuthSession";
import { Auth } from "../src/components/Auth";
import { registerComponents } from "../src/registerComponents";
import {
  registerCoreDeclaration,
  unregisterCoreDeclaration,
  getCoreDeclaration,
  _clearCoreRegistry,
} from "../src/coreRegistry";
import { ERROR_PREFIX, isOwnershipError, OWNERSHIP_ERROR_MARKER } from "../src/raiseError";
import { setConfig } from "../src/config";

vi.mock("@auth0/auth0-spa-js", () => ({
  createAuth0Client: vi.fn(),
}));

// Mock createRemoteCoreProxy so tests can control the "sync" timing.
// The returned object is an EventTarget with a constructor.wcBindable
// that matches the real proxy's shape: the declaration is rewritten with
// synthetic event names per property — but for bind() semantics we only
// need the property list and events to match.
//
// `@wc-bindable/core` v0.7.0 changed `bind()` initial sync from a
// `target[name] !== undefined` check to a `name in target` check, and the
// real `RemoteCoreProxy` answers `has` true ONLY for declared properties
// whose value has already been cached (i.e. arrived via a prior sync or
// update). The mock mirrors that contract by installing the property as an
// own data-property only on `_simulateSync`; before the first sync,
// `name in proxy` is false, so `bind()` does not deliver a phantom initial
// `undefined` value to subscribers.
//
// Note: createRemoteCoreProxy is mocked as a plain function (NOT vi.fn()) so
// that vi.restoreAllMocks() in afterEach does not wipe its implementation
// between tests.
//
// `proxyHooks.onCreate` lets an individual test observe / prepare the proxy
// right after construction (before `<auth0-session>` binds to it). It is
// reset in afterEach.
const proxyHooks = vi.hoisted(() => ({
  onCreate: null as null | ((proxy: EventTarget) => void),
}));

vi.mock("@wc-bindable/remote", async (importActual) => {
  const actual = await importActual<Record<string, unknown>>();
  const factory = (decl: WcBindableDeclaration) => {
    const EVENT_PREFIX = "mock-proxy:";
    const proxy = new EventTarget() as EventTarget & {
      _simulateSync(values: Record<string, unknown>): void;
    };
    const proxyDecl: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: decl.properties.map((p) => ({ name: p.name, event: EVENT_PREFIX + p.name })),
    };
    Object.defineProperty(proxy.constructor, "wcBindable", { value: proxyDecl, configurable: true });
    proxy._simulateSync = (values) => {
      for (const [name, value] of Object.entries(values)) {
        Object.defineProperty(proxy, name, {
          configurable: true,
          writable: true,
          enumerable: true,
          value,
        });
        proxy.dispatchEvent(new CustomEvent(EVENT_PREFIX + name, { detail: value }));
      }
    };
    proxyHooks.onCreate?.(proxy);
    return proxy as any;
  };
  return {
    ...actual,
    createRemoteCoreProxy: factory,
  };
});

registerComponents();

function createMockAuth0Client(overrides: Record<string, any> = {}) {
  return {
    isAuthenticated: vi.fn().mockResolvedValue(false),
    getUser: vi.fn().mockResolvedValue(null),
    getTokenSilently: vi.fn().mockResolvedValue("test-token"),
    loginWithRedirect: vi.fn().mockResolvedValue(undefined),
    loginWithPopup: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    handleRedirectCallback: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

const SAMPLE_DECL: WcBindableDeclaration = {
  protocol: "wc-bindable",
  version: 1,
  properties: [
    { name: "currentUser", event: "app:currentUser-changed" },
    { name: "items",       event: "app:items-changed" },
  ],
};

describe("AuthSession (auth0-session)", () => {
  let createAuth0Client: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("@auth0/auth0-spa-js");
    createAuth0Client = (mod as any).createAuth0Client;
    createAuth0Client.mockReset();
    registerCoreDeclaration("app-core", SAMPLE_DECL);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
    _clearCoreRegistry();
    proxyHooks.onCreate = null;
  });

  it("registered as a custom element", () => {
    expect(customElements.get("auth0-session")).toBeDefined();
  });

  it("exposes the expected bindable surface", () => {
    expect(AuthSession.wcBindable.properties.map((p) => p.name))
      .toEqual(["ready", "connecting", "error"]);
  });

  describe("attributes", () => {
    it("target / core / url / auto-connect round-trip", () => {
      const el = document.createElement("auth0-session") as AuthSession;
      expect(el.target).toBe("");
      el.target = "auth";
      expect(el.target).toBe("auth");

      expect(el.core).toBe("");
      el.core = "app-core";
      expect(el.core).toBe("app-core");

      expect(el.url).toBe("");
      el.url = "wss://example.com";
      expect(el.url).toBe("wss://example.com");

      expect(el.autoConnect).toBe(true); // default
      el.autoConnect = false;
      expect(el.autoConnect).toBe(false);
      el.autoConnect = true;
      expect(el.autoConnect).toBe(true);
    });

    it("observedAttributes lists the external-facing attributes", () => {
      expect(AuthSession.observedAttributes).toEqual([
        "target", "core", "url", "auto-connect",
      ]);
    });

    it("attributeChangedCallback is a no-op when the element is not connected", () => {
      const el = document.createElement("auth0-session") as AuthSession;
      // Spy on the private worker that the callback would trigger if
      // it were NOT a no-op under disconnect. We assert on `_startWatching`
      // so the test actually catches a regression that reintroduces
      // re-init on detached elements.
      const spy = vi.spyOn(el as any, "_startWatching");
      el.attributeChangedCallback("target", null, "x");
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("recovers when target/core are stamped AFTER connect (late-bound attrs)", async () => {
      // Regression: declarative / framework integrations often mount the
      // element before the attribute values are available. Previously the
      // first `_startWatching()` would set a permanent "target not found"
      // / missing-core error and never retry — attributes were observed
      // but the callback was a no-op.
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-late";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      // Mount without any attributes — the first `_startWatching()`
      // captures a missing target and records an error.
      const el = document.createElement("auth0-session") as AuthSession;
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      // Missing attributes land on the target-not-found error first
      // (empty `target` does not resolve to any element).
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain("not found");
      expect(el.proxy).toBeNull();

      // Now stamp the attributes — the late-bind hook must flush the
      // previous error and re-enter `_startWatching()`.
      el.setAttribute("target", "auth-late");
      el.setAttribute("core", "app-core");

      // Microtask coalescing: drain the scheduled restart, then its
      // internal awaits (authEl.connectedCallbackPromise + connect()).
      await new Promise((r) => setTimeout(r, 0));

      expect(el.error).toBeNull();
      expect(el.proxy).not.toBeNull();
      expect(el.transport).not.toBeNull();
    });

    it("does not restart a live session on unrelated attribute changes", async () => {
      // Regression: the late-bind hook must NOT re-enter `_startWatching()`
      // once a transport is live — doing so would tear down the working
      // proxy. Only restart when the session is idle (no transport, no
      // connecting).
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-live";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-live";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      const firstProxy = el.proxy;
      expect(firstProxy).not.toBeNull();
      expect(connectSpy).toHaveBeenCalledTimes(1);

      // Mutate a monitored attribute while a transport is live — must
      // NOT restart.
      el.setAttribute("url", "wss://other.example.com/ws");
      await new Promise((r) => setTimeout(r, 0));

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(el.proxy).toBe(firstProxy);
    });

    it("does not schedule an attribute-driven restart while detached", async () => {
      const el = document.createElement("auth0-session") as AuthSession;
      el.setAttribute("auto-connect", "");
      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it("does not schedule an attribute-driven restart when auto-connect is already false", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-attr-disabled";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-attr-disabled";
      el.core = "app-core";
      el.autoConnect = false;
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it("cancels a scheduled attribute-driven restart when auto-connect becomes false before the microtask", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-attr-auto-flip";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-attr-auto-flip";
      el.core = "app-core";
      el.setAttribute("auto-connect", "");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);
      vi.spyOn(el, "autoConnect", "get")
        .mockReturnValueOnce(true)
        .mockReturnValue(false);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it("cancels a scheduled attribute-driven restart when a connect begins before the microtask", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-attr-connecting";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-attr-connecting";
      el.core = "app-core";
      el.setAttribute("auto-connect", "");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      (el as any)._connecting = true;
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });

    it("cancels a scheduled attribute-driven restart when the element disconnects before the microtask", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-attr-disconnect";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-attr-disconnect";
      el.core = "app-core";
      el.setAttribute("auto-connect", "");
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const startSpy = vi.spyOn(el as any, "_startWatching").mockResolvedValue(undefined);

      el.attributeChangedCallback("url", "ws://before", "ws://after");
      el.remove();
      await Promise.resolve();

      expect(startSpy).not.toHaveBeenCalled();
    });
  });

  describe("error cases", () => {
    it("sets error when target is not in the DOM", async () => {
      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "missing";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain('target "missing" not found');
    });

    it("sets error when no payload source is provided", async () => {
      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      createAuth0Client.mockResolvedValue(createMockAuth0Client());
      document.body.appendChild(authEl);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      // no `core` attribute and no wc-bindable child
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error).toBeInstanceOf(Error);
      // Error message names both supported sources so the developer sees
      // which knobs are available (child element OR registry).
      expect(el.error?.message).toContain("no payload source");
      expect(el.error?.message).toContain("wc-bindable child");
      expect(el.error?.message).toContain("`core` attribute");
    });

    it("sets error when core key is not registered", async () => {
      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      createAuth0Client.mockResolvedValue(createMockAuth0Client());
      document.body.appendChild(authEl);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "unknown-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain('core "unknown-core" is not registered');
    });

    it("sets error when target id resolves to a non-<auth0-gate> element", async () => {
      const notAuth = document.createElement("div");
      notAuth.id = "auth";
      document.body.appendChild(notAuth);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain('target "auth" not found');
    });

    it("reports a target that carries the gate tag name but has not upgraded yet as not found", async () => {
      // Script-load race: the element is parsed with the configured
      // <auth0-gate> tag name before its definition arrives, so it has no
      // `connect()` / `connectedCallbackPromise`. Reproduced by pointing the
      // configured tag at a name that is never defined.
      const pendingTag = "pending-session-gate";
      setConfig({ tagNames: { auth: pendingTag } });
      try {
        const pending = document.createElement(pendingTag);
        pending.id = "auth";
        document.body.appendChild(pending);

        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        el.core = "app-core";
        document.body.appendChild(el);
        await el.connectedCallbackPromise;

        expect(el.error?.message).toContain('target "auth" not found');
        expect(el.proxy).toBeNull();
        expect(el.connecting).toBe(false);
      } finally {
        setConfig({ tagNames: { auth: "auth0-gate" } });
      }
    });

    it("sets a friendly error when neither session.url nor target.remote-url is set", async () => {
      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      // NO remote-url on target — and no `url` on session below.
      // Force authenticated=true so _connect actually runs.
      createAuth0Client.mockResolvedValue(createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
      }));
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Spy must not be called: validation has to fail BEFORE shell.connect.
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect");

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      // Note: explicitly leaving mode local-vs-remote alone; target has no
      // remote-url so this exercises the contract failure path.
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).not.toHaveBeenCalled();
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain("no WebSocket URL configured");
      expect(el.error?.message).toContain("`url` attribute on <auth0-session>");
      expect(el.error?.message).toContain("`remote-url` on the target <auth0-gate>");
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.connecting).toBe(false);
    });
  });

  describe("happy path", () => {
    async function setupAuthenticated({
      remoteUrl = "wss://example.com/ws",
    }: { remoteUrl?: string } = {}) {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", remoteUrl);
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Stub the shell's connect to return a fake transport synchronously.
      const fakeTransport = { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
      vi.spyOn((authEl as any)._shell, "connect").mockResolvedValue(fakeTransport);

      return { authEl, fakeTransport };
    }

    it("connects and flips ready=true after first sync batch", async () => {
      const { authEl } = await setupAuthenticated();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      await el.connectedCallbackPromise;

      expect(el.proxy).not.toBeNull();
      expect(el.transport).not.toBeNull();
      expect(el.ready).toBe(false);

      // Simulate server sync.
      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });

      // `_setReady` is queued in a microtask so the whole batch lands first.
      await Promise.resolve();

      expect(el.ready).toBe(true);
      expect(el.error).toBeNull();

      // No-op: authEl is referenced to silence unused-var
      expect(authEl.connected).toBe(false); // spied connect didn't flip real state
    });

    it("passes the explicit `url` attribute to authEl.connect()", async () => {
      const { authEl } = await setupAuthenticated({ remoteUrl: "" });
      const connectSpy = vi.mocked((authEl as any)._shell.connect);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.url = "wss://override.example.com/ws";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      // Session also forwards `failIfConnected: true` as the atomic
      // ownership guard — see the SPEC-REMOTE §3.7 regression test in
      // "mutual exclusion". Assert by URL only here to keep this
      // signature check focused on URL resolution.
      expect(connectSpy.mock.calls[0][0]).toBe("wss://override.example.com/ws");
    });

    it("falls back to target's remote-url when `url` is not set", async () => {
      const { authEl } = await setupAuthenticated({ remoteUrl: "wss://fallback.example.com/ws" });
      const connectSpy = vi.mocked((authEl as any)._shell.connect);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy.mock.calls[0][0]).toBe("wss://fallback.example.com/ws");
    });

    it("dispatches ready-changed and connecting-changed events", async () => {
      await setupAuthenticated();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";

      const connectingEvents: boolean[] = [];
      const readyEvents: boolean[] = [];
      el.addEventListener("auth0-session:connecting-changed",
        (e) => connectingEvents.push((e as CustomEvent).detail));
      el.addEventListener("auth0-session:ready-changed",
        (e) => readyEvents.push((e as CustomEvent).detail));

      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ currentUser: null, items: [] });
      await Promise.resolve();

      expect(connectingEvents).toEqual([true, false]);
      expect(readyEvents).toEqual([true]);
    });

    it("does not flip ready when the proxy is torn down before the queued ready microtask runs", async () => {
      const { authEl } = await setupAuthenticated();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));
      await Promise.resolve();

      expect(el.ready).toBe(false);
      expect(el.proxy).toBeNull();
    });
  });

  describe("auth state transitions", () => {
    it("waits for authenticated-changed(true) before connecting", async () => {
      const mockClient = createMockAuth0Client(); // isAuthenticated defaults to false
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).not.toHaveBeenCalled();
      expect(el.proxy).toBeNull();

      // Simulate auth flipping to true.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));

      // Wait for the async connect chain.
      await new Promise((r) => setTimeout(r, 0));

      expect(connectSpy).toHaveBeenCalled();
      expect(el.proxy).not.toBeNull();
    });

    it("does not install a proxy when connected=false fires before _connect resumes", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-race";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const fakeTransport = { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
      vi.spyOn(authEl, "connect").mockImplementation(async () => {
        // Simulate the server closing the just-opened socket in the
        // microtask gap between `await auth.connect(...)` resolving and
        // AuthSession's `_connect()` resuming.
        queueMicrotask(() => {
          authEl.dispatchEvent(new CustomEvent("auth0-gate:connected-changed", {
            detail: false,
          }));
        });
        return fakeTransport as any;
      });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-race";
      el.core = "app-core";
      document.body.appendChild(el);

      await el.connectedCallbackPromise;
      await Promise.resolve();

      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.ready).toBe(false);
      expect(el.connecting).toBe(false);
    });

    it("tears down proxy + clears ready when authenticated flips back to false", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });
      await Promise.resolve();
      expect(el.ready).toBe(true);

      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      expect(el.ready).toBe(false);
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
    });
    it("ignores connected-changed(false) when no session state is active", async () => {
      // NB: This test deliberately fires `connected-changed` manually on
      // the Auth element — it verifies the LOCAL contract that the
      // session's listener is a no-op when no transport/ready/connecting
      // state exists. The end-to-end propagation chain (AuthShell._
      // setConnected → Auth element → AuthSession listener) is locked
      // in separately by the K-001 regression test further down; the
      // two concerns are intentionally tested in isolation so a bug in
      // one surface does not mask the other.
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-idle";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-idle";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      authEl.dispatchEvent(new CustomEvent("auth0-gate:connected-changed", {
        detail: false,
      }));

      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.ready).toBe(false);
      expect(el.connecting).toBe(false);
    });

    // Cycle 9 (K-001): AuthShell._setConnected previously dispatched
    // `auth0-gate:connected-changed` on `this` (the AuthShell instance),
    // but AuthSession registers the listener on the Auth element. The
    // event therefore landed on the wrong EventTarget and the session
    // never saw transport loss (4401/4403/1008/1006/network). This
    // regression locks in the end-to-end propagation chain — if anyone
    // reverts the dispatch target back to `this`, the assertion fails.
    //
    // Coverage: (a) ready=true is flipped via the normal connect path
    // (not manually), (b) transport loss is triggered by invoking the
    // real `_setConnected(false)` on the shell — NOT by dispatching
    // the event on the Auth element manually — so the test fails if
    // and only if `_setConnected` dispatches on the wrong target.
    it("tears down when transport is lost via shell._setConnected(false) (K-001)", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-k001";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Stub only AuthShell.connect (not the low-level _setConnected
      // surface) so the session's internal state advances through the
      // real connect path: _transport set, proxy installed, ready flips
      // true after the first sync batch. Critically we do NOT stub
      // `_setConnected` — that is exactly the function K-001 moves,
      // and we need the real implementation to fire on teardown.
      const shell = (authEl as any)._shell;
      const connectSpy = vi.spyOn(shell, "connect").mockImplementation(async () => {
        shell._setConnected(true);
        return { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() } as any;
      });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth-k001";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });
      await Promise.resolve();

      expect(connectSpy).toHaveBeenCalled();
      expect(el.ready).toBe(true);
      expect(el.transport).not.toBeNull();
      expect(el.proxy).not.toBeNull();

      // Simulate transport loss via the SHELL's own _setConnected(false)
      // — the real production path that fires on 4401/4403/1008/1006
      // close codes. If `_setConnected` dispatched on the shell instance
      // (the K-001 bug), the event would not reach the Auth element,
      // AuthSession's listener would never fire, and the session would
      // linger in ready=true pointing at a dead transport.
      shell._setConnected(false);

      expect(el.ready).toBe(false);
      expect(el.transport).toBeNull();
      expect(el.proxy).toBeNull();
    });

    // Cycle 9 (K-001 complement): the listener AuthSession registers
    // on the Auth element must receive the event when AuthShell
    // _setConnected fires. This is a thinner check than the E2E
    // teardown test above — it asserts only that the listener fires
    // at all with the correct `detail`, catching future regressions
    // even if the session's teardown logic changes.
    it("AuthShell._setConnected reaches listeners on the Auth element (K-001)", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth-propagation";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const events: boolean[] = [];
      authEl.addEventListener("auth0-gate:connected-changed", (e) => {
        events.push((e as CustomEvent).detail);
      });

      const shell = (authEl as any)._shell;
      shell._setConnected(true);
      shell._setConnected(false);

      expect(events).toEqual([true, false]);
    });
  });

  describe("mutual exclusion with manual connect()", () => {
    it("fails fast when target is already connected (SPEC-REMOTE §3.7)", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Simulate the application having already called authEl.connect() —
      // force the shell into a "connected" state before the session starts.
      const shell = (authEl as any)._shell;
      shell._setConnected(true);
      const connectSpy = vi.spyOn(shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).not.toHaveBeenCalled();
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toContain("target is already connected");
      expect(el.error?.message).toContain("§3.7");
      // Cycle 7 (I-003): the ownership error carries the stable
      // `_authOwnership` sentinel so `_startWatching` can preserve
      // it across auto-restarts without relying on message matching.
      expect((el.error as unknown as Record<string, unknown>)[OWNERSHIP_ERROR_MARKER]).toBe(true);
      expect(isOwnershipError(el.error)).toBe(true);
    });

    it("preserves a standing ownership error across attribute-driven restarts (I-003)", async () => {
      // Regression: a framework that restamps `target` / `core` / `url`
      // after the first run triggers `attributeChangedCallback` ->
      // `_startWatching`, which used to clear the just-shown ownership
      // error. The stable `_authOwnership` sentinel lets
      // `isOwnershipError()` recognise it and preserve it across the
      // coalesced restart — even if the human-readable message drifts.
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const shell = (authEl as any)._shell;
      shell._setConnected(true);
      vi.spyOn(shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const firstError = el.error;
      expect(firstError).toBeInstanceOf(Error);
      expect(isOwnershipError(firstError)).toBe(true);

      // Re-stamping the URL should coalesce through
      // attributeChangedCallback. Since there's no live transport the
      // restart fires, and the preserved ownership error must survive
      // through the `_setError(null)` that would otherwise clear it.
      // The ownership condition is still true after the restart, so
      // `_connect` re-sets a (new) ownership error — what matters is
      // that the error surface never flipped to `null` mid-restart,
      // which would have been visible as an error-changed event with
      // `null` detail. Capture dispatched events to assert that.
      const errorEvents: Array<Error | null> = [];
      el.addEventListener("auth0-session:error", (e) => {
        errorEvents.push((e as CustomEvent).detail);
      });

      el.setAttribute("url", "wss://alt.example.com/ws");
      await el.connectedCallbackPromise;
      // Flush the microtask-coalesced restart queue.
      await Promise.resolve();
      await Promise.resolve();

      // The preserved-error path never fires an error-changed(null)
      // event: a message-substring match would have broken silently,
      // but the `_authOwnership` sentinel keeps the guard intact.
      expect(errorEvents.every((e) => e !== null)).toBe(true);
      expect(isOwnershipError(el.error)).toBe(true);
    });

    it("passes failIfConnected:true through to AuthShell.connect (TOCTOU guard)", async () => {
      // Regression: the outer `auth.connected` check in AuthSession is
      // a fast path, not an atomic guard. A concurrent caller could
      // take the connection between that check and the `await
      // auth.connect()` microtask boundary. The session must pass
      // `failIfConnected: true` so AuthShell.connect() synchronously
      // claims ownership before any await — rejecting racing callers
      // instead of tearing down their sockets.
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const shell = (authEl as any)._shell;
      const connectSpy = vi.spyOn(shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(connectSpy).toHaveBeenCalledTimes(1);
      const [url, options] = connectSpy.mock.calls[0];
      expect(url).toBe("wss://example.com/ws");
      expect(options).toEqual({ failIfConnected: true });
    });
  });

  describe("connect failure", () => {
    it("sets error when authEl.connect() rejects", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect").mockRejectedValue(new Error("handshake failed"));

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("handshake failed");
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.connecting).toBe(false);
    });

    it("normalises non-Error rejections to Error instances", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect").mockRejectedValue("string rejection");

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("string rejection");
    });
  });

  describe("connection release (real AuthShell over a mock WebSocket)", () => {
    // These tests run the real AuthShell.connect() against a mock
    // WebSocket, so what the session closes is observable on the sockets
    // and on the target's `connected` / `connected-changed`.
    class MockSocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      static instances: MockSocket[] = [];

      readyState = MockSocket.CONNECTING;
      closeCode: number | undefined;
      // Every close() call, including ones on an already-closed socket.
      closeCalls = 0;
      private _listeners: Record<string, Array<(event: unknown) => void>> = {};

      constructor(public url: string, public protocols?: string | string[]) {
        MockSocket.instances.push(this);
        // Open on a later task, like a real handshake, so an in-flight
        // connect stays observable across microtasks.
        setTimeout(() => {
          if (this.readyState !== MockSocket.CONNECTING) return;
          this.readyState = MockSocket.OPEN;
          this._emit("open", {});
        }, 0);
      }

      addEventListener(type: string, listener: (event: unknown) => void): void {
        (this._listeners[type] ??= []).push(listener);
      }

      removeEventListener(type: string, listener: (event: unknown) => void): void {
        const list = this._listeners[type] ?? [];
        const idx = list.indexOf(listener);
        if (idx >= 0) list.splice(idx, 1);
      }

      send(_data: string): void {}

      close(code?: number, reason?: string): void {
        this.closeCalls++;
        if (this.readyState === MockSocket.CLOSED) return;
        this.readyState = MockSocket.CLOSED;
        this.closeCode = code;
        this._emit("close", { code, reason });
      }

      private _emit(type: string, event: unknown): void {
        for (const fn of [...(this._listeners[type] ?? [])]) fn(event);
      }
    }

    const RELEASE_PAYLOAD_DECL: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "count", event: "release-payload:count-changed" },
        { name: "label", event: "release-payload:label-changed" },
      ],
      commands: [{ name: "increment" }, { name: "decrement" }],
    };

    let releaseTagSeq = 0;
    function definePayloadTag(decl: WcBindableDeclaration): string {
      const tag = `release-payload-${++releaseTagSeq}`;
      customElements.define(tag, class extends HTMLElement {
        static wcBindable = decl;
      });
      return tag;
    }

    beforeEach(() => {
      MockSocket.instances = [];
      vi.stubGlobal("WebSocket", MockSocket);
    });

    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function mountGate() {
      createAuth0Client.mockResolvedValue(createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      }));
      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("audience", "https://api.example.com");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      const connectedEvents: boolean[] = [];
      authEl.addEventListener("auth0-gate:connected-changed",
        (e) => connectedEvents.push((e as CustomEvent).detail));
      return { authEl, connectedEvents };
    }

    async function mountSession(configure: (el: AuthSession) => void): Promise<AuthSession> {
      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      configure(el);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;
      return el;
    }

    // The failed attempt closed the one socket it opened, `connected`
    // went back to false (with the event), and nothing of the attempt
    // survives on the session.
    function expectReleased(authEl: Auth, el: AuthSession, connectedEvents: boolean[]): void {
      expect(MockSocket.instances).toHaveLength(1);
      expect(MockSocket.instances[0].readyState).toBe(MockSocket.CLOSED);
      expect(MockSocket.instances[0].closeCode).toBe(1000);
      expect(authEl.connected).toBe(false);
      expect(connectedEvents).toEqual([true, false]);
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.payload).toBeNull();
      expect(el.connecting).toBe(false);
      expect(el.ready).toBe(false);
    }

    // With the cause removed, `start()` on the same element connects.
    async function expectRetrySucceeds(
      authEl: Auth,
      el: AuthSession,
      syncValues: Record<string, unknown>,
    ): Promise<void> {
      await el.start();
      expect(el.error).toBeNull();
      expect(el.proxy).not.toBeNull();
      expect(authEl.connected).toBe(true);
      expect(MockSocket.instances).toHaveLength(2);
      expect(MockSocket.instances[1].readyState).toBe(MockSocket.OPEN);
      (el.proxy as any)._simulateSync(syncValues);
      await Promise.resolve();
      expect(el.ready).toBe(true);
    }

    // Lets the mock sockets open (they do so on a later task).
    const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    // Pumps microtasks until the session has created its `n`-th socket,
    // i.e. a handshake is in flight but has not opened yet.
    async function untilSocketCount(n: number): Promise<void> {
      for (let i = 0; i < 100 && MockSocket.instances.length < n; i++) {
        await Promise.resolve();
      }
      expect(MockSocket.instances).toHaveLength(n);
      expect(MockSocket.instances[n - 1].readyState).toBe(MockSocket.CONNECTING);
    }

    describe("failure after the handshake releases the connection", () => {
      // `auth.connect()` succeeded, then setting the session up failed. The
      // session used to drop its reference to the transport without
      // closing it, so `<auth0-gate>` stayed `connected=true` with an open
      // WebSocket nobody owned and every `start()` retry failed the
      // Connection Ownership guard (SPEC-REMOTE §3.7) until logout.
      it("closes the connection when createRemoteCoreProxy throws, and start() can retry", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const failure = new Error("proxy construction failed");
        proxyHooks.onCreate = () => { throw failure; };

        const el = await mountSession((s) => { s.core = "app-core"; });

        expect(el.error).toBe(failure);
        expectReleased(authEl, el, connectedEvents);

        proxyHooks.onCreate = null;
        await expectRetrySucceeds(authEl, el, { currentUser: { sub: "u" }, items: [] });
      });

      it("closes the connection when the payload declaration loses its properties after discovery, and start() can retry", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const decl = { ...RELEASE_PAYLOAD_DECL };
        const tag = definePayloadTag(decl);
        // The application mutates the declaration while the handshake runs —
        // after discovery validated it, before the proxy is built from it.
        authEl.addEventListener("auth0-gate:connected-changed", () => {
          delete (decl as Partial<WcBindableDeclaration>).properties;
        }, { once: true });
        const child = document.createElement(tag);

        const el = await mountSession((s) => s.appendChild(child));

        expect(el.error).toBeInstanceOf(Error);
        expectReleased(authEl, el, connectedEvents);

        decl.properties = RELEASE_PAYLOAD_DECL.properties;
        await expectRetrySucceeds(authEl, el, { count: 1 });
        expect(el.payload).toBe(child);
        expect((child as any).count).toBe(1);
      });

      it("closes the connection when bind()'s synchronous initial sync throws, and start() can retry", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const failure = new Error("cached value unreadable");
        // A cached property whose read throws makes bind() throw from its
        // synchronous initial sync.
        proxyHooks.onCreate = (proxy) => {
          Object.defineProperty(proxy, "items", {
            get() { throw failure; },
            configurable: true,
          });
        };

        const el = await mountSession((s) => { s.core = "app-core"; });

        expect(el.error).toBe(failure);
        expectReleased(authEl, el, connectedEvents);

        proxyHooks.onCreate = null;
        await expectRetrySucceeds(authEl, el, { currentUser: null, items: [] });
      });

      it("lets an `error` listener retry synchronously with start()", async () => {
        // The error is published after the failed attempt's state is
        // cleared and before its connection is released; a restart begun
        // from the listener must neither be undone by that cleanup nor hit
        // the ownership guard.
        const { authEl, connectedEvents } = await mountGate();
        const tag = definePayloadTag(RELEASE_PAYLOAD_DECL);
        let failuresLeft = 1;
        proxyHooks.onCreate = () => {
          if (failuresLeft-- > 0) throw new Error("transient proxy failure");
        };
        const child = document.createElement(tag);
        let retry: Promise<void> | undefined;

        const el = await mountSession((s) => {
          s.appendChild(child);
          s.addEventListener("auth0-session:error", (e) => {
            if ((e as CustomEvent).detail && !retry) retry = s.start();
          });
        });
        expect(retry).toBeDefined();
        await retry;

        expect(el.error).toBeNull();
        expect(el.payload).toBe(child);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true, false, true]);
        expect(MockSocket.instances.map((s) => s.readyState))
          .toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        (el.proxy as any)._simulateSync({ count: 7 });
        expect((child as any).count).toBe(7);
        await Promise.resolve();
        expect(el.ready).toBe(true);
      });

      it("still releases the connection when the failing attempt was already superseded by a teardown", async () => {
        // A payload listener unmounts the session during bind()'s initial
        // sync, then a later property read throws. The error is swallowed
        // (the attempt is stale), but its connection was never handed to a
        // live session and must not outlive it.
        const { authEl, connectedEvents } = await mountGate();
        const tag = definePayloadTag(RELEASE_PAYLOAD_DECL);
        proxyHooks.onCreate = (proxy) => {
          Object.defineProperty(proxy, "count", {
            value: 1, writable: true, configurable: true, enumerable: true,
          });
          Object.defineProperty(proxy, "label", {
            get() { throw new Error("label unreadable"); },
            configurable: true,
          });
        };
        const child = document.createElement(tag);
        const errorEvents: unknown[] = [];

        const el = await mountSession((s) => {
          s.appendChild(child);
          child.addEventListener("release-payload:count-changed", () => s.remove(), { once: true });
          s.addEventListener("auth0-session:error", (e) => errorEvents.push((e as CustomEvent).detail));
        });

        expect(el.error).toBeNull();
        expect(errorEvents).toEqual([]);
        expectReleased(authEl, el, connectedEvents);

        // Remounting the session connects instead of failing ownership.
        proxyHooks.onCreate = null;
        document.body.appendChild(el);
        await el.connectedCallbackPromise;
        expect(el.error).toBeNull();
        expect(el.proxy).not.toBeNull();
        expect(authEl.connected).toBe(true);
        expect(MockSocket.instances).toHaveLength(2);
      });

      it("leaves another owner's connection open when the ownership guard rejects the handshake", async () => {
        // The application opens the connection itself while the session
        // starts. `auth.connect()` rejects, so the session established
        // nothing and must not close anything.
        const { authEl, connectedEvents } = await mountGate();
        const appConnect = authEl.connect();

        const el = await mountSession((s) => { s.core = "app-core"; });
        await appConnect;

        expect(isOwnershipError(el.error)).toBe(true);
        expect(el.connecting).toBe(false);
        expect(MockSocket.instances).toHaveLength(1);
        expect(MockSocket.instances[0].readyState).toBe(MockSocket.OPEN);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true]);
      });

      it("does not close a connection that replaced the session's own before the failure path ran", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const shell = (authEl as any)._shell;
        const realConnect = shell.connect.bind(shell);
        vi.spyOn(shell, "connect").mockImplementationOnce(async (...args: unknown[]) => {
          const [url, options] = args as [string, { failIfConnected?: boolean }];
          const sessionTransport = await realConnect(url, options);
          // Another owner takes the connection over before the session
          // resumes from its handshake.
          await realConnect(url);
          return sessionTransport;
        });
        proxyHooks.onCreate = () => { throw new Error("proxy construction failed"); };

        const el = await mountSession((s) => { s.core = "app-core"; });

        expect(el.error?.message).toBe("proxy construction failed");
        expect(MockSocket.instances).toHaveLength(2);
        // The session's socket was closed by the take-over, not by the
        // session; the other owner's socket is untouched.
        expect(MockSocket.instances[1].readyState).toBe(MockSocket.OPEN);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true]);
      });
    });

    describe("a locked command name fails the session with an error that says why", () => {
      // A declared command's forwarder cannot be installed on a name the
      // application locked. The session still fails on purpose — running
      // on would leave `payload.<command>()` calling the application's
      // member, so the command would never reach the server — but the
      // error names the command, the lock and the fix instead of a bare
      // "Cannot redefine property" TypeError, and the regular failure
      // path cleans up.

      it("names the command and its non-configurable lock, removes the forwarders already installed, closes the connection, and start() recovers with an unlocked element", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const tag = definePayloadTag(RELEASE_PAYLOAD_DECL);
        const lockedChild = document.createElement(tag);
        // `decrement` is declared after `increment`, so the forwarder for
        // `increment` is already installed when the lock is hit.
        const appDecrement = (): string => "app";
        Object.defineProperty(lockedChild, "decrement", {
          value: appDecrement, writable: false, configurable: false,
        });
        const errorEvents: unknown[] = [];

        const el = await mountSession((s) => {
          s.appendChild(lockedChild);
          s.addEventListener("auth0-session:error", (e) => errorEvents.push((e as CustomEvent).detail));
        });

        const err = el.error;
        expect(err).toBeInstanceOf(Error);
        expect(err).not.toBeInstanceOf(TypeError);
        expect(errorEvents).toEqual([err]);
        expect(err?.message.startsWith(`${ERROR_PREFIX} <auth0-session>: `)).toBe(true);
        expect(err?.message).toContain(`cannot install the forwarder for command "decrement" on payload <${tag}>`);
        expect(err?.message).toContain(`<${tag}>.decrement is a non-configurable own property`);
        expect(err?.message).toContain("payload.decrement() never reaches the server");
        expect(err?.message).toContain(`Stop locking "decrement"`);
        expect(err?.message).toContain(`remove "decrement" from its wcBindable.commands, then call start()`);

        // Cleanup ran through the existing failure path: the forwarder
        // installed before the lock was hit is gone, the application's
        // locked member is untouched, and the connection is closed.
        expectReleased(authEl, el, connectedEvents);
        expect(Object.prototype.hasOwnProperty.call(lockedChild, "increment")).toBe(false);
        expect((lockedChild as any).decrement).toBe(appDecrement);

        // A lock cannot be undone on that element; remove the cause by
        // mounting an unlocked one, then retry.
        lockedChild.remove();
        const child = document.createElement(tag);
        el.appendChild(child);
        await expectRetrySucceeds(authEl, el, { count: 2 });
        expect(el.payload).toBe(child);
        expect(typeof (child as any).increment).toBe("function");
        expect(typeof (child as any).decrement).toBe("function");
      });

      it("names a non-extensible payload the same way, and start() recovers once the command is removed from the declaration", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const decl: WcBindableDeclaration = { ...RELEASE_PAYLOAD_DECL, commands: [{ name: "increment" }] };
        const tag = definePayloadTag(decl);
        const child = document.createElement(tag);
        // Lock the element after it is in the document, before the
        // session installs anything on it.
        authEl.addEventListener("auth0-gate:connected-changed", () => {
          Object.preventExtensions(child);
        }, { once: true });

        const el = await mountSession((s) => s.appendChild(child));

        expect(el.error?.message).toContain(`cannot install the forwarder for command "increment" on payload <${tag}>`);
        expect(el.error?.message).toContain(`<${tag}> is non-extensible`);
        expect(el.error?.message).toContain(`"increment" cannot be added to it`);
        expectReleased(authEl, el, connectedEvents);
        expect(Object.prototype.hasOwnProperty.call(child, "increment")).toBe(false);

        // Drop the command from the declaration and retry. The element
        // stays non-extensible, so mirrored properties are skipped with a
        // warning, but the session runs.
        decl.commands = [];
        vi.spyOn(console, "warn").mockImplementation(() => {});
        await expectRetrySucceeds(authEl, el, { count: 3 });
        expect(el.payload).toBe(child);
      });
    });

    describe("the session's end gives its connection back", () => {
      // The session owns the connection it opened. Logout, removal from
      // the DOM and a `start()` restart all end the session, and each
      // gives that connection back (closes it through the target), so the
      // next run — a remount, `start()` — does not fail the Connection
      // Ownership guard (SPEC-REMOTE §3.7) against a connection nobody
      // uses any more. A connection the session did not open is never
      // closed.

      function createSession(): AuthSession {
        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        el.core = "app-core";
        return el;
      }

      async function mountReadySession() {
        const { authEl, connectedEvents } = await mountGate();
        const readyEvents: boolean[] = [];
        const el = await mountSession((s) => {
          s.core = "app-core";
          s.addEventListener("auth0-session:ready-changed",
            (e) => readyEvents.push((e as CustomEvent).detail));
        });
        await expectSynced(el);
        expect(authEl.connected).toBe(true);
        return { authEl, connectedEvents, el, readyEvents };
      }

      async function expectSynced(el: AuthSession): Promise<void> {
        expect(el.error).toBeNull();
        (el.proxy as any)._simulateSync({ currentUser: { sub: "u" }, items: [] });
        await Promise.resolve();
        expect(el.ready).toBe(true);
      }

      function socketStates(): number[] {
        return MockSocket.instances.map((s) => s.readyState);
      }

      it("start() on a live session closes its connection, reconnects, and returns to ready", async () => {
        const { authEl, connectedEvents, el, readyEvents } = await mountReadySession();
        const firstProxy = el.proxy;

        await el.start();

        expect(el.error).toBeNull();
        expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        expect(MockSocket.instances[0].closeCode).toBe(1000);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true, false, true]);
        expect(el.proxy).not.toBeNull();
        expect(el.proxy).not.toBe(firstProxy);
        await expectSynced(el);
        expect(readyEvents).toEqual([true, false, true]);
      });

      it("removing the session closes its connection, and adding it back reconnects", async () => {
        const { authEl, connectedEvents, el } = await mountReadySession();

        el.remove();

        expect(socketStates()).toEqual([MockSocket.CLOSED]);
        expect(MockSocket.instances[0].closeCode).toBe(1000);
        expect(authEl.connected).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
        expect(el.ready).toBe(false);
        expect(el.proxy).toBeNull();
        expect(el.transport).toBeNull();

        document.body.appendChild(el);
        await el.connectedCallbackPromise;

        expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true, false, true]);
        await expectSynced(el);
      });

      it("moving the session within the DOM in one task reconnects instead of failing ownership", async () => {
        const { authEl, el } = await mountReadySession();
        const container = document.createElement("div");
        document.body.appendChild(container);

        container.appendChild(el); // disconnectedCallback, then connectedCallback
        await el.connectedCallbackPromise;

        expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        expect(authEl.connected).toBe(true);
        await expectSynced(el);
      });

      it("removing the session mid-handshake closes that connection as soon as the handshake completes", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const el = createSession();
        document.body.appendChild(el);
        await untilSocketCount(1);
        expect(el.connecting).toBe(true);

        el.remove();
        expect(el.connecting).toBe(false);
        // The abandoned attempt finishes: its handshake opens, and the
        // connection it delivers is given back at once.
        await el.connectedCallbackPromise;

        expect(socketStates()).toEqual([MockSocket.CLOSED]);
        expect(MockSocket.instances[0].closeCode).toBe(1000);
        expect(authEl.connected).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
        expect(el.proxy).toBeNull();
        expect(el.transport).toBeNull();
        expect(el.error).toBeNull();
      });

      it("adding the session back mid-handshake waits for the abandoned handshake, then connects", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const el = createSession();
        document.body.appendChild(el);
        await untilSocketCount(1);

        el.remove();
        document.body.appendChild(el);
        await el.connectedCallbackPromise;

        expect(el.error).toBeNull();
        expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        expect(MockSocket.instances[0].closeCode).toBe(1000);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true, false, true]);
        await expectSynced(el);
      });

      it("start() mid-handshake closes the abandoned handshake's connection and connects again", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const el = createSession();
        const connectingEvents: boolean[] = [];
        el.addEventListener("auth0-session:connecting-changed",
          (e) => connectingEvents.push((e as CustomEvent).detail));
        document.body.appendChild(el);
        await untilSocketCount(1);

        await el.start();

        expect(el.error).toBeNull();
        expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        expect(MockSocket.instances[0].closeCode).toBe(1000);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true, false, true]);
        // The restart reads `connecting` throughout its wait.
        expect(connectingEvents).toEqual([true, false, true, false]);
        await expectSynced(el);
      });

      it("a restart begun after the handshake opened, but before the session resumed from it, waits instead of failing ownership", async () => {
        // A `connected-changed: true` listener runs while the target
        // already reports `connected=true` for the session's own
        // handshake, before that attempt resumed to install (or, now
        // superseded, give back) the connection.
        const { authEl, connectedEvents } = await mountGate();
        const el = createSession();
        let restart: Promise<void> | undefined;
        authEl.addEventListener("auth0-gate:connected-changed", (e) => {
          if ((e as CustomEvent).detail === true && !restart) restart = el.start();
        });
        document.body.appendChild(el);
        await el.connectedCallbackPromise;
        expect(restart).toBeDefined();
        await restart;

        expect(el.error).toBeNull();
        expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true, false, true]);
        await expectSynced(el);
      });

      it("removing the session while a restart waits for the abandoned handshake leaves nothing open", async () => {
        const { authEl, connectedEvents } = await mountGate();
        const el = createSession();
        document.body.appendChild(el);
        await untilSocketCount(1);
        const restart = el.start();
        // Let the restart reach `_connect()`, where it waits.
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(el.connecting).toBe(true);

        el.remove();
        await restart;

        expect(socketStates()).toEqual([MockSocket.CLOSED]);
        expect(authEl.connected).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
        expect(el.connecting).toBe(false);
        expect(el.proxy).toBeNull();
        expect(el.error).toBeNull();
      });

      it("logout closes the connection exactly once: the gate closes it, the session finds nothing left to release", async () => {
        const { authEl, connectedEvents, el, readyEvents } = await mountReadySession();
        const socket = MockSocket.instances[0];

        await authEl.logout();

        expect(socket.closeCalls).toBe(1);
        expect(socket.readyState).toBe(MockSocket.CLOSED);
        expect(authEl.connected).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
        expect(el.ready).toBe(false);
        expect(readyEvents).toEqual([true, false]);
        expect(el.proxy).toBeNull();
        expect(el.error).toBeNull();
      });

      it("a server close ends the session without a second close or event, and start() reconnects", async () => {
        const { authEl, connectedEvents, el } = await mountReadySession();
        const socket = MockSocket.instances[0];

        socket.close(4401, "Session expired"); // server-initiated

        expect(socket.closeCalls).toBe(1);
        expect(authEl.connected).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
        expect(el.ready).toBe(false);
        expect(el.proxy).toBeNull();

        await el.start();
        expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        expect(connectedEvents).toEqual([true, false, true]);
        await expectSynced(el);
      });

      it("authenticated flipping to false without a logout closes the session's connection", async () => {
        const { authEl, connectedEvents, el } = await mountReadySession();

        authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", { detail: false }));

        expect(MockSocket.instances[0].closeCalls).toBe(1);
        expect(socketStates()).toEqual([MockSocket.CLOSED]);
        expect(authEl.connected).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
        expect(el.ready).toBe(false);
      });

      it("removing the gate together with the session closes the socket once and announces it once", async () => {
        const { authEl, connectedEvents } = await mountReadySession();

        document.body.innerHTML = "";
        await Promise.resolve(); // the gate's deferred disconnect()

        expect(MockSocket.instances[0].closeCalls).toBe(1);
        expect(authEl.connected).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
      });

      it("never closes the application's own connection: a session that lost the ownership check leaves it open on start() and on removal", async () => {
        const { authEl, connectedEvents } = await mountGate();
        await authEl.connect(); // Pattern B: the application owns the connection

        const el = await mountSession((s) => { s.core = "app-core"; });
        expect(isOwnershipError(el.error)).toBe(true);
        await el.start();
        expect(isOwnershipError(el.error)).toBe(true);
        el.remove();

        expect(socketStates()).toEqual([MockSocket.OPEN]);
        expect(MockSocket.instances[0].closeCalls).toBe(0);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true]);
      });

      it("a second session on the same gate leaves the first session's connection open when it is restarted or removed", async () => {
        const { authEl, connectedEvents, el: first } = await mountReadySession();
        const second = await mountSession((s) => { s.core = "app-core"; });
        expect(isOwnershipError(second.error)).toBe(true);

        await second.start();
        second.remove();

        expect(socketStates()).toEqual([MockSocket.OPEN]);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true]);
        expect(first.ready).toBe(true);
        expect(first.proxy).not.toBeNull();
      });

      it("does not close a connection that a take-over connect() opened in place of the session's", async () => {
        const { authEl, connectedEvents, el } = await mountReadySession();
        await authEl.connect(); // no failIfConnected: replaces the session's socket

        el.remove();

        expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
        expect(MockSocket.instances[1].closeCalls).toBe(0);
        expect(authEl.connected).toBe(true);
        expect(connectedEvents).toEqual([true]);
      });

      describe("a replacement authEl.reconnect() opened for the session's connection stays the session's (Strategy B)", () => {
        // `reconnect()` closes the session's socket and opens a new one
        // without publishing `connected=false`; the application then
        // re-attaches `session.proxy` to the result (SPEC-REMOTE §3.4.1).
        // The session used to know only the first transport, so its end
        // left the replacement open and every `start()` / remount failed
        // the ownership guard against it until logout. The replacement
        // continues the session's connection: `transport` returns it and
        // the session's end closes it.

        function deferred<T>() {
          let resolve!: (value: T) => void;
          const promise = new Promise<T>((r) => { resolve = r; });
          return { promise, resolve };
        }

        // The Strategy B flow: reconnect, then re-attach the session's
        // proxy (a stand-in for `RemoteCoreProxy.reconnect`) to the result.
        async function reconnectSession(authEl: Auth, el: AuthSession) {
          const reattach = vi.fn();
          Object.assign(el.proxy as object, { reconnect: reattach });
          const replacement = await authEl.reconnect();
          (el.proxy as unknown as { reconnect(t: unknown): void }).reconnect(replacement);
          expect(reattach).toHaveBeenCalledWith(replacement);
          return replacement;
        }

        async function mountReconnectedSession() {
          const ready = await mountReadySession();
          const firstTransport = ready.el.transport;
          const replacement = await reconnectSession(ready.authEl, ready.el);
          // The replacement is live, nothing was announced, the session
          // carries on, and its `transport` is the replacement.
          expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
          expect(MockSocket.instances[0].closeCalls).toBe(1);
          expect(ready.connectedEvents).toEqual([true]);
          expect(ready.el.ready).toBe(true);
          expect(ready.el.transport).toBe(replacement);
          expect(replacement).not.toBe(firstTransport);
          return { ...ready, replacement };
        }

        // Pumps microtasks until `reconnect()` has asked Auth0 for its
        // fresh token, i.e. it is parked in the token fetch.
        async function untilTokenRequested(authEl: Auth, count: number): Promise<void> {
          const getTokenSilently = (authEl.client as { getTokenSilently: ReturnType<typeof vi.fn> }).getTokenSilently;
          for (let i = 0; i < 100 && getTokenSilently.mock.calls.length < count; i++) {
            await Promise.resolve();
          }
          expect(getTokenSilently.mock.calls).toHaveLength(count);
        }

        function holdNextToken(authEl: Auth) {
          const token = deferred<string>();
          const getTokenSilently = (authEl.client as { getTokenSilently: ReturnType<typeof vi.fn> }).getTokenSilently;
          getTokenSilently.mockImplementationOnce(() => token.promise);
          return { token, calls: getTokenSilently.mock.calls.length };
        }

        const SUPERSEDED_IN_HANDSHAKE =
          "reconnect(): superseded by the release of the connection it was replacing, during handshake.";
        const SUPERSEDED_IN_TOKEN_FETCH =
          "reconnect(): superseded by the release of the connection it was replacing, during token fetch.";

        it("start() closes the replacement, reconnects, and returns to ready", async () => {
          const { authEl, connectedEvents, el, readyEvents, replacement } = await mountReconnectedSession();

          await el.start();

          expect(el.error).toBeNull();
          expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.CLOSED, MockSocket.OPEN]);
          expect(MockSocket.instances[1].closeCalls).toBe(1);
          expect(MockSocket.instances[1].closeCode).toBe(1000);
          expect(authEl.connected).toBe(true);
          expect(connectedEvents).toEqual([true, false, true]);
          expect(el.transport).not.toBeNull();
          expect(el.transport).not.toBe(replacement);
          await expectSynced(el);
          expect(readyEvents).toEqual([true, false, true]);
        });

        it("removing the session closes the replacement, and adding it back reconnects", async () => {
          const { authEl, connectedEvents, el } = await mountReconnectedSession();

          el.remove();

          expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.CLOSED]);
          expect(MockSocket.instances[1].closeCalls).toBe(1);
          expect(MockSocket.instances[1].closeCode).toBe(1000);
          expect(authEl.connected).toBe(false);
          expect(connectedEvents).toEqual([true, false]);
          expect(el.ready).toBe(false);
          expect(el.proxy).toBeNull();
          expect(el.transport).toBeNull();

          document.body.appendChild(el);
          await el.connectedCallbackPromise;

          expect(el.error).toBeNull();
          expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.CLOSED, MockSocket.OPEN]);
          expect(connectedEvents).toEqual([true, false, true]);
          await expectSynced(el);
        });

        it.each([
          ["authenticated turning false", (authEl: Auth) => {
            authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", { detail: false }));
          }],
          ["logout()", async (authEl: Auth) => { await authEl.logout(); }],
          ["a server close", () => { MockSocket.instances[1].close(4401, "Session expired"); }],
        ])("%s ends the session with the replacement closed exactly once and announced once", async (_name, end) => {
          const { authEl, connectedEvents, el } = await mountReconnectedSession();

          await end(authEl);

          expect(MockSocket.instances[1].closeCalls).toBe(1);
          expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.CLOSED]);
          expect(authEl.connected).toBe(false);
          expect(connectedEvents).toEqual([true, false]);
          expect(el.ready).toBe(false);
          expect(el.proxy).toBeNull();
          expect(el.transport).toBeNull();
          expect(el.error).toBeNull();
        });

        it("several reconnects in a row: the session owns the latest replacement", async () => {
          const { authEl, connectedEvents, el } = await mountReadySession();
          await reconnectSession(authEl, el);
          await reconnectSession(authEl, el);
          const latest = await reconnectSession(authEl, el);

          expect(el.transport).toBe(latest);
          expect(socketStates()).toEqual([
            MockSocket.CLOSED, MockSocket.CLOSED, MockSocket.CLOSED, MockSocket.OPEN,
          ]);
          expect(connectedEvents).toEqual([true]);

          el.remove();

          expect(MockSocket.instances.map((s) => s.closeCalls)).toEqual([1, 1, 1, 1]);
          expect(authEl.connected).toBe(false);
          expect(connectedEvents).toEqual([true, false]);

          document.body.appendChild(el);
          await el.connectedCallbackPromise;
          expect(el.error).toBeNull();
          expect(MockSocket.instances).toHaveLength(5);
          expect(MockSocket.instances[4].readyState).toBe(MockSocket.OPEN);
          await expectSynced(el);
        });

        describe("a connection the session does not own is not taken over when it is reconnected", () => {
          it("the application's own connection (Pattern B)", async () => {
            const { authEl, connectedEvents } = await mountGate();
            await authEl.connect();
            const el = await mountSession((s) => { s.core = "app-core"; });
            expect(isOwnershipError(el.error)).toBe(true);

            await authEl.reconnect();
            await el.start();
            expect(isOwnershipError(el.error)).toBe(true);
            el.remove();

            expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
            expect(MockSocket.instances[1].closeCalls).toBe(0);
            expect(authEl.connected).toBe(true);
            expect(connectedEvents).toEqual([true]);
          });

          it("a take-over connect()'s connection", async () => {
            const { authEl, connectedEvents, el } = await mountReadySession();
            await authEl.connect(); // replaces the session's socket
            await authEl.reconnect(); // replaces the take-over's socket

            el.remove();

            expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.CLOSED, MockSocket.OPEN]);
            expect(MockSocket.instances[2].closeCalls).toBe(0);
            expect(authEl.connected).toBe(true);
            expect(connectedEvents).toEqual([true]);
          });

          it("a second session leaves the first session's replacement alone; the first session closes it", async () => {
            const { authEl, connectedEvents, el: first } = await mountReadySession();
            const second = await mountSession((s) => { s.core = "app-core"; });
            expect(isOwnershipError(second.error)).toBe(true);
            const replacement = await reconnectSession(authEl, first);

            await second.start();
            expect(isOwnershipError(second.error)).toBe(true);
            expect(second.transport).toBeNull();
            second.remove();

            expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
            expect(MockSocket.instances[1].closeCalls).toBe(0);
            expect(connectedEvents).toEqual([true]);
            expect(first.ready).toBe(true);
            expect(first.transport).toBe(replacement);

            first.remove();
            expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.CLOSED]);
            expect(MockSocket.instances[1].closeCalls).toBe(1);
            expect(connectedEvents).toEqual([true, false]);
          });
        });

        describe("the session ends while reconnect() is replacing its connection", () => {
          // The release cannot cancel the reconnect's handshake. It gives
          // the connection up at once (`connected=false`); the reconnect
          // discards its new socket — or does not open one — when it
          // resumes, and rejects. A run started meanwhile waits for that
          // instead of failing the ownership guard.

          it("removal during the handshake: the replacement is closed as soon as it opens, and reconnect() rejects", async () => {
            const { authEl, connectedEvents, el } = await mountReadySession();
            const pending = authEl.reconnect();
            await untilSocketCount(2);

            el.remove();

            expect(authEl.connected).toBe(false);
            expect(connectedEvents).toEqual([true, false]);
            await expect(pending).rejects.toThrow(SUPERSEDED_IN_HANDSHAKE);
            expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.CLOSED]);
            expect(MockSocket.instances[1].closeCalls).toBe(1);
            expect(MockSocket.instances[1].closeCode).toBe(1000);
            expect(authEl.connected).toBe(false);
            expect(connectedEvents).toEqual([true, false]);
            expect(el.transport).toBeNull();
            expect(el.error).toBeNull();
          });

          it("start() during the handshake waits for the reconnect to give up, then connects", async () => {
            const { authEl, connectedEvents, el } = await mountReadySession();
            const errorEvents: unknown[] = [];
            el.addEventListener("auth0-session:error", (e) => errorEvents.push((e as CustomEvent).detail));
            const pending = authEl.reconnect();
            await untilSocketCount(2);

            const restart = el.start();
            for (let i = 0; i < 10; i++) await Promise.resolve();
            expect(el.connecting).toBe(true);
            expect(MockSocket.instances).toHaveLength(2);

            await expect(pending).rejects.toThrow(SUPERSEDED_IN_HANDSHAKE);
            await restart;

            expect(el.error).toBeNull();
            expect(errorEvents).toEqual([]);
            expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.CLOSED, MockSocket.OPEN]);
            expect(MockSocket.instances[1].closeCalls).toBe(1);
            expect(authEl.connected).toBe(true);
            expect(connectedEvents).toEqual([true, false, true]);
            await expectSynced(el);
          });

          it("removal during the token fetch: the connection closes at once, and reconnect() opens none and rejects", async () => {
            const { authEl, connectedEvents, el } = await mountReadySession();
            const { token, calls } = holdNextToken(authEl);
            const pending = authEl.reconnect();
            await untilTokenRequested(authEl, calls + 1);

            el.remove();

            expect(socketStates()).toEqual([MockSocket.CLOSED]);
            expect(MockSocket.instances[0].closeCalls).toBe(1);
            expect(MockSocket.instances[0].closeCode).toBe(1000);
            expect(authEl.connected).toBe(false);
            expect(connectedEvents).toEqual([true, false]);

            token.resolve("fresh-token");
            await expect(pending).rejects.toThrow(SUPERSEDED_IN_TOKEN_FETCH);
            expect(MockSocket.instances).toHaveLength(1);
            expect(connectedEvents).toEqual([true, false]);
            expect(el.error).toBeNull();
          });

          it("start() during the token fetch waits for the reconnect to give up, then connects", async () => {
            const { authEl, connectedEvents, el } = await mountReadySession();
            const { token, calls } = holdNextToken(authEl);
            const pending = authEl.reconnect();
            await untilTokenRequested(authEl, calls + 1);

            const restart = el.start();
            for (let i = 0; i < 10; i++) await Promise.resolve();
            expect(el.connecting).toBe(true);
            expect(socketStates()).toEqual([MockSocket.CLOSED]);
            expect(connectedEvents).toEqual([true, false]);

            token.resolve("fresh-token");
            await expect(pending).rejects.toThrow(SUPERSEDED_IN_TOKEN_FETCH);
            await restart;

            expect(el.error).toBeNull();
            expect(socketStates()).toEqual([MockSocket.CLOSED, MockSocket.OPEN]);
            expect(authEl.connected).toBe(true);
            expect(connectedEvents).toEqual([true, false, true]);
            await expectSynced(el);
          });
        });
      });
    });
  });

  describe("auto-connect=false", () => {
    it("does not start until start() is called", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.setAttribute("auto-connect", "false");
      document.body.appendChild(el);

      // Give queueMicrotask a chance to fire.
      await Promise.resolve();
      expect(connectSpy).not.toHaveBeenCalled();

      await el.start();
      expect(connectSpy).toHaveBeenCalled();
    });
  });

  describe("re-start does not leak listeners", () => {
    /**
     * Helper: install a session whose target is currently NOT authenticated,
     * so `_startWatching` registers the listener but does not call
     * `_connect()` immediately. Returns spies on the auth element's
     * add/remove EventListener so tests can count listener registrations.
     */
    async function setupUnauthenticatedSession() {
      const mockClient = createMockAuth0Client(); // isAuthenticated → false
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const addSpy = vi.spyOn(authEl, "addEventListener");
      const removeSpy = vi.spyOn(authEl, "removeEventListener");
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      return { authEl, addSpy, removeSpy, connectSpy };
    }

    function countAuthChangedListeners(
      spy: { mock: { calls: Parameters<Auth["addEventListener"]>[] } },
    ): number {
      return spy.mock.calls.filter(
        (args) => args[0] === "auth0-gate:authenticated-changed",
      ).length;
    }

    it("calling start() twice registers exactly one listener net", async () => {
      const { authEl, addSpy, removeSpy, connectSpy } = await setupUnauthenticatedSession();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.setAttribute("auto-connect", "false");
      document.body.appendChild(el);

      await el.start();
      await el.start();
      await el.start();

      const added = countAuthChangedListeners(addSpy);
      const removed = countAuthChangedListeners(removeSpy);

      // Three start() calls add three listeners but the second and third
      // each remove the previous one first → net 1 active listener.
      expect(added).toBe(3);
      expect(removed).toBe(2);

      // A single authenticated-changed dispatch must trigger _connect()
      // exactly once. With the leak, every previous listener also fires
      // and connectSpy would be called multiple times.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it("calling start() after auto-connect already ran does not duplicate listeners", async () => {
      const { authEl, addSpy, removeSpy, connectSpy } = await setupUnauthenticatedSession();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      // auto-connect default = true
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      // Auto-connect already registered one listener.
      expect(countAuthChangedListeners(addSpy)).toBe(1);
      expect(countAuthChangedListeners(removeSpy)).toBe(0);

      await el.start();

      // start() must remove the auto-connect listener before adding its own.
      expect(countAuthChangedListeners(addSpy)).toBe(2);
      expect(countAuthChangedListeners(removeSpy)).toBe(1);

      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      expect(connectSpy).toHaveBeenCalledTimes(1);
    });

    it("retry via start() after a handshake failure does not leak the failed listener", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const addSpy = vi.spyOn(authEl, "addEventListener");
      const removeSpy = vi.spyOn(authEl, "removeEventListener");

      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockRejectedValueOnce(new Error("transient handshake failure"))
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.setAttribute("auto-connect", "false");
      document.body.appendChild(el);

      await el.start();
      expect(el.error).toBeInstanceOf(Error);
      expect(el.error?.message).toBe("transient handshake failure");

      await el.start();

      // Old listener removed, new listener installed; previous error cleared.
      expect(countAuthChangedListeners(addSpy)).toBe(2);
      expect(countAuthChangedListeners(removeSpy)).toBe(1);
      expect(el.error).toBeNull();
      expect(el.proxy).not.toBeNull(); // second connect succeeded
      expect(connectSpy).toHaveBeenCalledTimes(2);
    });

    it("disconnectedCallback removes the active listener exactly once", async () => {
      const { authEl, addSpy, removeSpy } = await setupUnauthenticatedSession();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      el.setAttribute("auto-connect", "false");
      document.body.appendChild(el);
      await el.start();
      await el.start();

      // 2 adds, 1 remove from the second start() invocation.
      expect(countAuthChangedListeners(addSpy)).toBe(2);
      expect(countAuthChangedListeners(removeSpy)).toBe(1);

      el.remove();

      // disconnectedCallback removes the active listener; total removes = 2.
      expect(countAuthChangedListeners(removeSpy)).toBe(2);

      // No further dispatches should reach the session.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      // proxy stays null because no listener fires now.
      expect(el.proxy).toBeNull();
    });
  });

  describe("race: teardown during in-flight connect", () => {
    /**
     * Helper: build an authEl whose _shell.connect returns a promise we
     * control, so tests can interleave events between "connect() called"
     * and "connect() resolves".
     */
    async function setupDeferredConnect() {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      let resolveConnect!: (t: unknown) => void;
      let rejectConnect!: (e: unknown) => void;
      const connectPromise = new Promise((resolve, reject) => {
        resolveConnect = resolve;
        rejectConnect = reject;
      });
      const connectSpy = vi.spyOn((authEl as any)._shell, "connect")
        .mockReturnValue(connectPromise as any);
      return { authEl, connectSpy, resolveConnect, rejectConnect };
    }

    it("discards a handshake that completes AFTER authenticated=false", async () => {
      const { authEl, resolveConnect } = await setupDeferredConnect();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      // Pump microtasks so _startWatching reaches `await auth.connect()`.
      await Promise.resolve();
      await Promise.resolve();
      expect(el.connecting).toBe(true);

      // Simulate logout DURING the handshake.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));
      expect(el.connecting).toBe(false); // teardown flipped it immediately

      // Handshake resolves AFTER the teardown.
      resolveConnect({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
      await el.connectedCallbackPromise;

      // The stale transport must NOT be installed; `ready` must stay false.
      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.ready).toBe(false);
      expect(el.error).toBeNull();
      expect(el.connecting).toBe(false);
    });

    it("discards a handshake that completes AFTER element removal", async () => {
      const { authEl, resolveConnect } = await setupDeferredConnect();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      await Promise.resolve();
      await Promise.resolve();
      expect(el.connecting).toBe(true);

      // Remove the element mid-handshake.
      el.remove();
      expect(el.connecting).toBe(false);

      // Handshake resolves AFTER the removal.
      resolveConnect({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
      await el.connectedCallbackPromise;

      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();
      expect(el.ready).toBe(false);

      // authEl is referenced to keep the test intentional.
      expect(authEl.id).toBe("auth");
    });

    it("discards the first attempt but succeeds on re-auth after false→true bounce", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      // Explicit per-call sequencing: first call returns the deferred for
      // the stale handshake, second call returns the deferred for the
      // re-auth handshake. Avoids mockReturnValueOnce queue ambiguity.
      const deferreds: Array<{
        promise: Promise<unknown>;
        resolve: (t: unknown) => void;
      }> = [];
      vi.spyOn((authEl as any)._shell, "connect").mockImplementation(() => {
        let resolve!: (t: unknown) => void;
        const promise = new Promise<unknown>((r) => { resolve = r; });
        deferreds.push({ promise, resolve });
        return promise;
      });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);

      // Pump until the first _shell.connect() has been called.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(deferreds).toHaveLength(1);

      // First attempt gets interrupted by logout mid-handshake.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      // User logs in again before the first handshake settles. The new
      // attempt is `connecting` but does not start its own handshake yet:
      // the stale one still holds the target's single connection slot, so
      // a second `connect({ failIfConnected: true })` would be rejected as
      // an ownership conflict. It waits for the stale attempt to finish.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(deferreds).toHaveLength(1);
      expect(el.connecting).toBe(true);

      // Stale first handshake finally resolves — must be discarded, and
      // only then does the fresh attempt open its handshake.
      deferreds[0].resolve({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
      await new Promise((r) => setTimeout(r, 0));
      expect(el.proxy).toBeNull();
      expect(deferreds).toHaveLength(2);
      expect(el.connecting).toBe(true);

      // Fresh handshake resolves — this one is the live attempt.
      deferreds[1].resolve({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });
      await Promise.resolve();
      await Promise.resolve();

      expect(el.proxy).not.toBeNull();
      expect(el.connecting).toBe(false);

      // And sync completion still drives ready=true on the fresh proxy.
      (el.proxy as any)._simulateSync({ currentUser: null, items: [] });
      await Promise.resolve();
      expect(el.ready).toBe(true);
    });

    it("discards a handshake rejection that arrives AFTER teardown", async () => {
      const { authEl, rejectConnect } = await setupDeferredConnect();

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await Promise.resolve();
      await Promise.resolve();

      // Teardown first.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      // Then the stale attempt rejects — error must not surface.
      rejectConnect(new Error("stale handshake failure"));
      await el.connectedCallbackPromise;

      expect(el.error).toBeNull();
      expect(el.proxy).toBeNull();
      expect(el.ready).toBe(false);
    });
    it("bails out before listener installation when generation changes during auth init wait", async () => {
      const authEl = document.createElement("auth0-gate") as Auth;

      let resolveInit!: () => void;
      const delayedInit = new Promise<void>((resolve) => {
        resolveInit = resolve;
      });
      Object.defineProperty(authEl, "connectedCallbackPromise", {
        configurable: true,
        get: () => delayedInit,
      });

      const addSpy = vi.spyOn(authEl, "addEventListener");

      const el = document.createElement("auth0-session") as AuthSession;
      el.core = "app-core";

      vi.spyOn(el as any, "_resolveAuth").mockReturnValue(authEl);

      const pending = (el as any)._startWatching();
      (el as any)._generation = 2;
      resolveInit();
      await pending;

      expect(addSpy).not.toHaveBeenCalledWith("auth0-gate:authenticated-changed", expect.any(Function));
    });

    it("_connect() is a no-op when auth or declaration is missing", async () => {
      const el = document.createElement("auth0-session") as AuthSession;

      await expect((el as any)._connect()).resolves.toBeUndefined();

      (el as any)._authEl = document.createElement("auth0-gate") as Auth;
      await expect((el as any)._connect()).resolves.toBeUndefined();
      (el as any)._authEl = document.createElement("auth0-gate") as Auth;
      (el as any)._coreDecl = SAMPLE_DECL;
      (el as any)._connecting = true;
      await expect((el as any)._connect()).resolves.toBeUndefined();
    });
  });

  describe("disconnectedCallback", () => {
    it("tears down and removes auth listener", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;
      vi.spyOn((authEl as any)._shell, "connect")
        .mockResolvedValue({ send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() });

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "app-core";
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      el.remove();

      expect(el.proxy).toBeNull();
      expect(el.transport).toBeNull();

      // Dispatching authenticated-changed after removal should not re-connect.
      const connectSpy = vi.mocked((authEl as any)._shell.connect);
      connectSpy.mockClear();
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: true,
      }));
      await new Promise((r) => setTimeout(r, 0));
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });

  describe("child payload pattern", () => {
    // Counter to keep each test's custom-element tag unique — registering the
    // same name twice throws, and `customElements` has no public unregister.
    let payloadTagSeq = 0;
    function definePayloadTag(decl: WcBindableDeclaration): string {
      const tag = `test-payload-${++payloadTagSeq}`;
      class PayloadEl extends HTMLElement {
        static wcBindable = decl;
      }
      customElements.define(tag, PayloadEl);
      return tag;
    }

    async function setupAuthenticated() {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const authEl = document.createElement("auth0-gate") as Auth;
      authEl.id = "auth";
      authEl.setAttribute("domain", "d.auth0.com");
      authEl.setAttribute("client-id", "c");
      authEl.setAttribute("remote-url", "wss://example.com/ws");
      document.body.appendChild(authEl);
      await authEl.connectedCallbackPromise;

      const fakeTransport = { send: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
      vi.spyOn((authEl as any)._shell, "connect").mockResolvedValue(fakeTransport);

      return { authEl, fakeTransport };
    }

    const PAYLOAD_DECL: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [
        { name: "count",         event: "test-payload:count-changed" },
        { name: "lastUpdatedBy", event: "test-payload:last-updated-by-changed" },
      ],
      commands: [
        { name: "increment" },
        { name: "decrement" },
        { name: "reset" },
      ],
    };

    it("adopts the first wc-bindable child as the payload (no `core` attribute needed)", async () => {
      await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      // No `core` attribute, no registry entry — the child carries the schema.
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);

      await el.connectedCallbackPromise;

      expect(el.error).toBeNull();
      expect(el.proxy).not.toBeNull();
      expect(el.payload).toBe(child);
    });

    it("mirrors proxy property updates onto the payload child (own-property + event)", async () => {
      await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      // Capture events dispatched on the child (not on the proxy or session).
      const countEvents: number[] = [];
      const userEvents: string[] = [];
      child.addEventListener("test-payload:count-changed",
        (e) => countEvents.push((e as CustomEvent).detail));
      child.addEventListener("test-payload:last-updated-by-changed",
        (e) => userEvents.push((e as CustomEvent).detail));

      (el.proxy as any)._simulateSync({ count: 5, lastUpdatedBy: "alice@example.com" });

      // Properties land on the child as own data properties.
      expect((child as any).count).toBe(5);
      expect((child as any).lastUpdatedBy).toBe("alice@example.com");

      // Original event names from the user's declaration are dispatched on
      // the child — NOT the proxy's synthetic names.
      expect(countEvents).toEqual([5]);
      expect(userEvents).toEqual(["alice@example.com"]);
    });

    it("installs command forwarders on the payload that route to proxy.invoke()", async () => {
      await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      // Command names are own-properties on the child after connect.
      expect(typeof (child as any).increment).toBe("function");
      expect(typeof (child as any).decrement).toBe("function");
      expect(typeof (child as any).reset).toBe("function");

      // Spy on the proxy's invoke() to confirm forwarding.
      const invokeSpy = vi.fn().mockResolvedValue(undefined);
      (el.proxy as any).invoke = invokeSpy;

      (child as any).increment(1, 2);
      (child as any).reset();

      expect(invokeSpy).toHaveBeenNthCalledWith(1, "increment", 1, 2);
      expect(invokeSpy).toHaveBeenNthCalledWith(2, "reset");
    });

    it("`bind(child, ...)` from @wc-bindable/core observes mirrored updates", async () => {
      const { bind } = await import("@wc-bindable/core");
      await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      const updates: Array<[string, unknown]> = [];
      const unbind = bind(child, (name, value) => {
        updates.push([name, value]);
      });

      // bind() skips the initial-value callback when `target[name]` is
      // undefined (see `@wc-bindable/core`'s `bind`). At this point, no
      // sync has arrived so child[name] is undefined — `updates` stays
      // empty until a property event fires.
      expect(updates).toEqual([]);

      // Now simulate the server sync — bind's listener fires for each prop.
      (el.proxy as any)._simulateSync({ count: 7, lastUpdatedBy: "bob@example.com" });

      expect(updates).toContainEqual(["count", 7]);
      expect(updates).toContainEqual(["lastUpdatedBy", "bob@example.com"]);

      unbind();
    });

    it("child payload takes precedence over a registered `core` key", async () => {
      await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      // Register a different decl in the registry; child should win.
      registerCoreDeclaration("legacy-core", SAMPLE_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.core = "legacy-core";
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.payload).toBe(child);
      // The child's wcBindable (count, lastUpdatedBy) should be in effect —
      // not the legacy registry's (currentUser, items). Verify by checking
      // a count event mirrors but a currentUser event does not (the proxy
      // only knows about properties from the active declaration).
      (el.proxy as any)._simulateSync({ count: 42 });
      expect((child as any).count).toBe(42);
      expect((child as any).currentUser).toBeUndefined();
    });

    it("adopts an already-defined payload synchronously even when an unupgraded custom element precedes it", async () => {
      // The payload class is defined before discovery runs, so the
      // synchronous scan must step past the never-defined stranger and
      // return the payload without waiting on `whenDefined()` at all.
      // The async race (a payload that upgrades only after discovery
      // started, next to a sibling that never settles) is covered under
      // "async discovery" below.
      await setupAuthenticated();
      const whenDefinedSpy = vi.spyOn(customElements, "whenDefined");
      const payloadTag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";

      // Stranger first — `<perma-undefined-...>` is never registered.
      const stranger = document.createElement(`perma-undefined-${++payloadTagSeq}`);
      const child = document.createElement(payloadTag);
      el.appendChild(stranger);
      el.appendChild(child);

      document.body.appendChild(el);

      // A scan that waited on the stranger would never resolve. Race
      // against a generous timeout to fail loudly instead of hanging.
      const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250));
      const winner = await Promise.race([
        el.connectedCallbackPromise.then(() => "ok" as const),
        timeout,
      ]);

      expect(winner).toBe("ok");
      expect(el.error).toBeNull();
      expect(el.payload).toBe(child);
      expect(whenDefinedSpy).not.toHaveBeenCalled();
    });

    it("adopts a payload whose class is defined in the same task the session connects in", async () => {
      // e.g. `bootstrapAuth()` followed by `customElements.define(...)`
      // for the payload in one script: discovery is deferred to a
      // microtask after connect, so by the time it runs the child has
      // already upgraded and the synchronous scan picks it up — no
      // `whenDefined()` wait. A class defined only after discovery has
      // started is covered under "async discovery" below.
      await setupAuthenticated();
      const whenDefinedSpy = vi.spyOn(customElements, "whenDefined");

      // Use a tag name that is not yet defined when the session connects.
      const tag = `test-payload-late-${++payloadTagSeq}`;
      const child = document.createElement(tag);
      // The child is HTMLUnknownElement at this point — isWcBindable is false.

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.appendChild(child);
      document.body.appendChild(el);

      // Define the element AFTER appending, still in the same task.
      class LatePayload extends HTMLElement {
        static wcBindable = PAYLOAD_DECL;
      }
      customElements.define(tag, LatePayload);

      await el.connectedCallbackPromise;

      // Browsers upgrade `child` in place; happy-dom swaps in a fresh
      // node on define(), so `el.payload` is not `child` here. Verify by
      // tag and proxy presence instead, which is what callers care about.
      expect(el.error).toBeNull();
      expect(el.payload).not.toBeNull();
      expect(el.payload!.localName).toBe(tag);
      expect(el.proxy).not.toBeNull();
      expect(whenDefinedSpy).not.toHaveBeenCalled();
    });

    it("teardown removes mirrored properties and command forwarders from the child", async () => {
      const { authEl } = await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ count: 9, lastUpdatedBy: "u@e.com" });
      expect((child as any).count).toBe(9);
      expect(typeof (child as any).increment).toBe("function");

      // Tear down via authenticated-changed: false.
      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      // After teardown, the own-properties WE installed are gone.
      expect(Object.prototype.hasOwnProperty.call(child, "count")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(child, "lastUpdatedBy")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(child, "increment")).toBe(false);
      expect(el.payload).toBeNull();
      expect(el.proxy).toBeNull();
    });

    it("teardown deletes mirrored property values even when the user overwrote them mid-session (intentional)", async () => {
      // The mirror writes generic values (numbers / strings), so identity
      // comparison would be unreliable — a user write of `payload.count = 5`
      // between two server pushes that also report 5 is indistinguishable
      // from "still ours". The session opts for "session ends → mirror is
      // reset" instead of trying to preserve user writes.
      const { authEl } = await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ count: 1 });
      // User overwrites the mirrored value.
      (child as any).count = 99;
      expect((child as any).count).toBe(99);

      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      // Documented behaviour: teardown removes the own-property regardless
      // of whether we wrote 1 or the user wrote 99 — the mirror is reset.
      expect(Object.prototype.hasOwnProperty.call(child, "count")).toBe(false);
    });

    it("teardown tolerates mirrored properties the user deleted or locked mid-session", async () => {
      // Teardown only deletes mirrors that are still configurable own
      // properties. A user `delete` (no descriptor) or a lock
      // (configurable: false — deleting it would throw in strict mode)
      // must not break teardown or the rest of the cleanup.
      const { authEl } = await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ count: 3, lastUpdatedBy: "alice@example.com" });
      delete (child as any).count;
      Object.defineProperty(child, "lastUpdatedBy", {
        value: "pinned-by-app", writable: false, configurable: false,
      });

      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      expect(el.proxy).toBeNull();
      expect(el.payload).toBeNull();
      // The locked value is left alone; the deleted one stays absent.
      expect((child as any).lastUpdatedBy).toBe("pinned-by-app");
      expect(Object.prototype.hasOwnProperty.call(child, "count")).toBe(false);
      // The rest of the cleanup still ran: command forwarders are removed.
      expect(Object.prototype.hasOwnProperty.call(child, "increment")).toBe(false);
    });

    describe("mirroring onto properties the application locked", () => {
      // The mirror (re)defines a configurable own data property. Once the
      // application locks that slot — a `configurable: false` own property
      // (`Object.defineProperty`, `Object.seal`, `Object.freeze`) or a
      // non-extensible element — redefining it throws a TypeError, which
      // used to escape from the bind callback. A locked property that is
      // still writable is assigned instead; otherwise it is skipped (one
      // warning per property per session) without stopping the other
      // mirrors or the session lifecycle.
      const flush = () => new Promise((r) => setTimeout(r, 0));

      // Silences console.warn and returns only the `<auth0-session>`
      // warnings — the gate's unrelated remote-without-audience warning
      // may land in the same spy.
      function captureSessionWarnings() {
        const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
        return () => spy.mock.calls.filter(
          (call) => String(call[0]).startsWith("[@csbc-dev/auth0] <auth0-session>"),
        );
      }

      async function mountSession(prepareChild?: (child: HTMLElement) => void) {
        const { authEl } = await setupAuthenticated();
        const tag = definePayloadTag(PAYLOAD_DECL);
        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        const child = document.createElement(tag);
        prepareChild?.(child);
        el.appendChild(child);
        document.body.appendChild(el);
        await el.connectedCallbackPromise;
        const countEvents: unknown[] = [];
        const userEvents: unknown[] = [];
        child.addEventListener("test-payload:count-changed",
          (e) => countEvents.push((e as CustomEvent).detail));
        child.addEventListener("test-payload:last-updated-by-changed",
          (e) => userEvents.push((e as CustomEvent).detail));
        return { authEl, el, child, countEvents, userEvents };
      }

      it("skips a property locked mid-session and keeps mirroring the others", async () => {
        const { el, child, countEvents, userEvents } = await mountSession();
        const warnings = captureSessionWarnings();

        (el.proxy as any)._simulateSync({ count: 1, lastUpdatedBy: "alice@example.com" });
        await flush();
        expect(el.ready).toBe(true);

        Object.defineProperty(child, "count", {
          value: 100, writable: false, configurable: false, enumerable: true,
        });
        (el.proxy as any)._simulateSync({ count: 2, lastUpdatedBy: "bob@example.com" });
        (el.proxy as any)._simulateSync({ count: 3 });

        // The locked value stays, and its event is not re-dispatched with
        // a detail that would contradict `child.count`.
        expect((child as any).count).toBe(100);
        expect(countEvents).toEqual([1]);
        // The sibling property keeps mirroring.
        expect((child as any).lastUpdatedBy).toBe("bob@example.com");
        expect(userEvents).toEqual(["alice@example.com", "bob@example.com"]);
        // One warning per property, not one per server push.
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0][0]).toContain(`"count"`);
        expect(el.ready).toBe(true);
        expect(el.error).toBeNull();
        expect(el.proxy).not.toBeNull();
      });

      it("still flips ready when the whole first sync batch hits a locked property", async () => {
        const { el, child, countEvents } = await mountSession((c) => {
          Object.defineProperty(c, "count", {
            value: 0, writable: false, configurable: false, enumerable: true,
          });
        });
        const warnings = captureSessionWarnings();

        (el.proxy as any)._simulateSync({ count: 5 });
        await flush();

        expect(el.ready).toBe(true);
        expect(el.error).toBeNull();
        expect((child as any).count).toBe(0);
        expect(countEvents).toEqual([]);
        expect(warnings()).toHaveLength(1);
      });

      it("does not fail the session when bind()'s synchronous initial sync hits a locked property", async () => {
        // A transport that has the initial values cached before bind()
        // runs makes bind() call the callback synchronously, so a throw
        // there escapes bind() itself and lands in _connect()'s catch.
        proxyHooks.onCreate = (proxy) => {
          Object.defineProperty(proxy, "count", {
            value: 1, writable: true, configurable: true, enumerable: true,
          });
        };
        const warnings = captureSessionWarnings();
        const { el, child } = await mountSession((c) => {
          Object.defineProperty(c, "count", {
            value: 0, writable: false, configurable: false, enumerable: true,
          });
        });
        await flush();

        expect(el.error).toBeNull();
        expect(el.proxy).not.toBeNull();
        expect(el.payload).toBe(child);
        expect(el.ready).toBe(true);
        expect((child as any).count).toBe(0);
        expect(warnings()).toHaveLength(1);

        // The subscription is live: later updates still mirror.
        (el.proxy as any)._simulateSync({ lastUpdatedBy: "carol@example.com" });
        expect((child as any).lastUpdatedBy).toBe("carol@example.com");
      });

      it("writes through a sealed (locked but writable) property and skips names a non-extensible payload cannot gain", async () => {
        const { authEl, el, child, countEvents, userEvents } = await mountSession();
        const warnings = captureSessionWarnings();

        (el.proxy as any)._simulateSync({ count: 1 });
        Object.seal(child);
        (el.proxy as any)._simulateSync({ count: 2, lastUpdatedBy: "dave@example.com" });

        // `count` is non-configurable but still writable: assignment works.
        expect((child as any).count).toBe(2);
        expect(countEvents).toEqual([1, 2]);
        // `lastUpdatedBy` was never mirrored and the payload can no longer
        // gain own properties: skipped with a warning.
        expect(Object.prototype.hasOwnProperty.call(child, "lastUpdatedBy")).toBe(false);
        expect(userEvents).toEqual([]);
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0][0]).toContain(`"lastUpdatedBy"`);
        await flush();
        expect(el.ready).toBe(true);

        // Teardown still completes and leaves the sealed value alone.
        authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", { detail: false }));
        expect(el.proxy).toBeNull();
        expect(el.payload).toBeNull();
        expect((child as any).count).toBe(2);
      });

      it("skips the property and reports the cause when a locked accessor's setter throws", async () => {
        const cause = new Error("count is read-only in this app");
        const { el, child, countEvents, userEvents } = await mountSession((c) => {
          Object.defineProperty(c, "count", {
            get: () => 0,
            set: () => { throw cause; },
            configurable: false,
          });
        });
        const warnings = captureSessionWarnings();

        (el.proxy as any)._simulateSync({ count: 1, lastUpdatedBy: "erin@example.com" });
        await flush();

        expect((child as any).count).toBe(0);
        expect(countEvents).toEqual([]);
        expect(userEvents).toEqual(["erin@example.com"]);
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0][0]).toContain(`"count"`);
        expect(warnings()[0][1]).toBe(cause);
        expect(el.ready).toBe(true);
        expect(el.error).toBeNull();
      });
    });

    it("preserves a user-replaced command forwarder on teardown (identity match required)", async () => {
      const { authEl } = await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      const child = document.createElement(tag);
      el.appendChild(child);
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      (el.proxy as any)._simulateSync({ count: 1 });
      expect((child as any).count).toBe(1);

      // User replaces our forwarder mid-session.
      const userIncrement = vi.fn();
      (child as any).increment = userIncrement;

      authEl.dispatchEvent(new CustomEvent("auth0-gate:authenticated-changed", {
        detail: false,
      }));

      // Our identity check sees the user's replacement and leaves it alone.
      expect((child as any).increment).toBe(userIncrement);
    });

    it("surfaces an error (instead of crashing later) when the payload's declaration vanishes between discovery and read", async () => {
      // `isWcBindable()` performs a live property read of
      // `constructor.wcBindable`; an accessor-based declaration can
      // therefore answer differently on the next read.
      const { authEl } = await setupAuthenticated();
      const tag = `test-payload-${++payloadTagSeq}`;
      let reads = 0;
      class VanishingPayload extends HTMLElement {
        static get wcBindable(): WcBindableDeclaration | undefined {
          reads += 1;
          return reads === 1 ? PAYLOAD_DECL : undefined;
        }
      }
      customElements.define(tag, VanishingPayload);

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      el.appendChild(document.createElement(tag));
      document.body.appendChild(el);
      await el.connectedCallbackPromise;

      expect(el.error?.message).toContain(`payload child <${tag}> has no wcBindable declaration`);
      expect(el.payload).toBeNull();
      expect(el.proxy).toBeNull();
      expect((authEl as any)._shell.connect).not.toHaveBeenCalled();
    });

    it("disposes the bind subscription immediately when a payload listener tears the session down during bind()'s initial sync", async () => {
      // If the proxy already holds cached values when `bind()` runs (a
      // transport that delivers the initial sync synchronously), bind()
      // invokes the callback re-entrantly; the mirrored event lets user
      // code remove the session before bind() has even returned its
      // disposer. That disposer must still be called — not parked in
      // `_unbind` for a teardown that may never come.
      await setupAuthenticated();
      const tag = definePayloadTag(PAYLOAD_DECL);

      const removedEventTypes: string[] = [];
      proxyHooks.onCreate = (proxy) => {
        const original = proxy.removeEventListener.bind(proxy);
        proxy.removeEventListener = (type: string, ...rest: any[]) => {
          removedEventTypes.push(type);
          return original(type, ...(rest as [any, any]));
        };
        Object.defineProperty(proxy, "count", {
          value: 1, writable: true, configurable: true, enumerable: true,
        });
      };

      const el = document.createElement("auth0-session") as AuthSession;
      el.target = "auth";
      const child = document.createElement(tag);
      el.appendChild(child);
      const readyEvents: boolean[] = [];
      el.addEventListener("auth0-session:ready-changed", (e) => {
        readyEvents.push((e as CustomEvent).detail);
      });
      // The application unmounts the session as soon as it sees a value.
      child.addEventListener("test-payload:count-changed", () => el.remove());
      document.body.appendChild(el);

      await el.connectedCallbackPromise;
      await new Promise((r) => setTimeout(r, 0)); // drain the queued ready check

      // bind()'s disposer removed its listener for every proxy property.
      expect(removedEventTypes).toEqual(expect.arrayContaining([
        "mock-proxy:count",
        "mock-proxy:lastUpdatedBy",
      ]));
      expect(el.ready).toBe(false);
      expect(readyEvents).toEqual([]);
      expect(el.proxy).toBeNull();
      expect(el.payload).toBeNull();
      expect(el.error).toBeNull();
      expect(el.connecting).toBe(false);
      // The child is restored to its pre-adoption state.
      expect(Object.prototype.hasOwnProperty.call(child, "count")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(child, "increment")).toBe(false);
    });

    describe("async discovery (payload class defined after discovery started)", () => {
      // The session's discovery runs in a microtask after connect. These
      // tests settle the pending child only AFTER that point, so the
      // `customElements.whenDefined()` race is what picks the payload.
      const flush = () => new Promise((r) => setTimeout(r, 0));

      // Per the HTML spec (and in browsers) `customElements.define()`
      // upgrades an already-connected element IN PLACE before
      // `whenDefined()` resolves. happy-dom instead swaps in a fresh node,
      // so the instance the session holds would never look upgraded. For
      // the tests that need a wc-bindable upgrade to win, emulate the spec:
      // hold `whenDefined()` for the `test-payload-late-*` tags, upgrade
      // the original instance (prototype swap), then resolve.
      function emulateInPlaceUpgrade() {
        const gates = new Map<string, () => void>();
        const realWhenDefined = customElements.whenDefined.bind(customElements);
        vi.spyOn(customElements, "whenDefined").mockImplementation((name: string) => {
          if (!name.startsWith("test-payload-late-")) return realWhenDefined(name);
          return new Promise<CustomElementConstructor>((resolve) => {
            gates.set(name, () => resolve(HTMLElement as unknown as CustomElementConstructor));
          });
        });
        return (child: Element, decl: WcBindableDeclaration): void => {
          class Upgraded extends HTMLElement {
            static wcBindable = decl;
          }
          Object.setPrototypeOf(child, Upgraded.prototype);
          gates.get(child.localName)!();
        };
      }

      it("waits for the pending child and adopts it once it upgrades", async () => {
        const { authEl } = await setupAuthenticated();
        const upgrade = emulateInPlaceUpgrade();
        const tag = `test-payload-late-${++payloadTagSeq}`;

        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        const child = document.createElement(tag);
        el.appendChild(child);
        document.body.appendChild(el);
        await flush();

        // Still waiting: no payload, no error, no handshake yet.
        expect(el.payload).toBeNull();
        expect(el.error).toBeNull();
        expect((authEl as any)._shell.connect).not.toHaveBeenCalled();

        upgrade(child, PAYLOAD_DECL);
        await el.connectedCallbackPromise;

        expect(el.error).toBeNull();
        expect(el.payload).toBe(child);
        expect(el.proxy).not.toBeNull();
        expect((authEl as any)._shell.connect).toHaveBeenCalledTimes(1);
        // The adopted child is live: command forwarders are installed.
        expect(typeof (child as any).increment).toBe("function");
      });

      it("adopts the first wc-bindable child to upgrade, not the first in DOM order", async () => {
        await setupAuthenticated();
        const upgrade = emulateInPlaceUpgrade();
        const first = document.createElement(`test-payload-late-${++payloadTagSeq}`);
        const second = document.createElement(`test-payload-late-${++payloadTagSeq}`);

        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        el.appendChild(first);
        el.appendChild(second);
        document.body.appendChild(el);
        await flush();

        upgrade(second, PAYLOAD_DECL);
        await el.connectedCallbackPromise;
        expect(el.payload).toBe(second);

        // A later upgrade of an earlier sibling does not displace the
        // adopted payload (SPEC-REMOTE §3.7: one proxy per session).
        upgrade(first, PAYLOAD_DECL);
        await flush();
        expect(el.payload).toBe(second);
        expect(Object.prototype.hasOwnProperty.call(first, "increment")).toBe(false);
        expect(el.error).toBeNull();
      });

      it("falls back to the registered `core` when every candidate settles as non-wc-bindable (mixed children)", async () => {
        const { authEl } = await setupAuthenticated();
        const plainCustomTag = `test-plain-${++payloadTagSeq}`;
        customElements.define(plainCustomTag, class extends HTMLElement {});
        const lateTag = `test-plain-late-${++payloadTagSeq}`;

        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        el.core = "app-core";
        // A non-custom element, an already-defined non-bindable custom
        // element, a non-HTML (SVG) child and a not-yet-defined one.
        el.appendChild(document.createElement("div"));
        el.appendChild(document.createElement(plainCustomTag));
        el.appendChild(document.createElementNS("http://www.w3.org/2000/svg", "svg"));
        el.appendChild(document.createElement(lateTag));
        document.body.appendChild(el);
        await flush();
        expect((authEl as any)._shell.connect).not.toHaveBeenCalled();

        // The last candidate upgrades into a plain element: nothing is
        // wc-bindable, so the legacy registry path takes over.
        customElements.define(lateTag, class extends HTMLElement {});
        await el.connectedCallbackPromise;

        expect(el.error).toBeNull();
        expect(el.payload).toBeNull();
        expect(el.proxy).not.toBeNull();
        expect((authEl as any)._shell.connect).toHaveBeenCalledTimes(1);
      });

      it("does not stall on a dashed child whose name can never be defined (whenDefined rejects)", async () => {
        // `font-face` contains a dash but is a reserved name, so
        // customElements.whenDefined("font-face") rejects. Without
        // draining the pending counter on rejection, discovery (and
        // connectedCallbackPromise) would hang forever.
        const { authEl } = await setupAuthenticated();

        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        el.core = "app-core";
        el.appendChild(document.createElement("font-face"));
        document.body.appendChild(el);

        const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250));
        const winner = await Promise.race([
          el.connectedCallbackPromise.then(() => "ok" as const),
          timeout,
        ]);

        expect(winner).toBe("ok");
        expect(el.error).toBeNull();
        expect(el.payload).toBeNull();
        expect(el.proxy).not.toBeNull();
        expect((authEl as any)._shell.connect).toHaveBeenCalledTimes(1);
      });

      it("a never-definable dashed sibling does not prevent a pending payload from being adopted", async () => {
        const { authEl } = await setupAuthenticated();
        const upgrade = emulateInPlaceUpgrade();
        const child = document.createElement(`test-payload-late-${++payloadTagSeq}`);

        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        el.appendChild(document.createElement("font-face")); // whenDefined rejects
        el.appendChild(child);
        document.body.appendChild(el);
        await flush();

        // The rejected candidate is counted out, but discovery keeps
        // waiting for the remaining one instead of giving up.
        expect(el.error).toBeNull();
        expect((authEl as any)._shell.connect).not.toHaveBeenCalled();

        upgrade(child, PAYLOAD_DECL);
        await el.connectedCallbackPromise;

        expect(el.payload).toBe(child);
        expect(el.proxy).not.toBeNull();
        expect((authEl as any)._shell.connect).toHaveBeenCalledTimes(1);
      });

      it("abandons the run when the session is removed while waiting for the payload class", async () => {
        const { authEl } = await setupAuthenticated();
        const tag = `test-payload-late-${++payloadTagSeq}`;

        const el = document.createElement("auth0-session") as AuthSession;
        el.target = "auth";
        // No `core` fallback: a run that wrongly resumed after removal
        // would surface "no payload source" on the detached session.
        el.appendChild(document.createElement(tag));
        document.body.appendChild(el);
        await flush();

        el.remove();
        customElements.define(tag, class extends HTMLElement {
          static wcBindable = PAYLOAD_DECL;
        });
        await el.connectedCallbackPromise;
        await flush();

        expect(el.error).toBeNull();
        expect(el.payload).toBeNull();
        expect(el.proxy).toBeNull();
        expect((authEl as any)._shell.connect).not.toHaveBeenCalled();
      });
    });
  });

  describe("private state guards", () => {
    it("_setReady and _setConnecting do not dispatch duplicate events for the same value", () => {
      const el = document.createElement("auth0-session") as AuthSession;
      const readyEvents: boolean[] = [];
      const connectingEvents: boolean[] = [];

      el.addEventListener("auth0-session:ready-changed", (e) => {
        readyEvents.push((e as CustomEvent).detail);
      });
      el.addEventListener("auth0-session:connecting-changed", (e) => {
        connectingEvents.push((e as CustomEvent).detail);
      });

      (el as any)._setReady(true);
      (el as any)._setReady(true);
      (el as any)._setConnecting(true);
      (el as any)._setConnecting(true);

      expect(readyEvents).toEqual([true]);
      expect(connectingEvents).toEqual([true]);
    });
  });
});

describe("coreRegistry", () => {
  afterEach(() => {
    _clearCoreRegistry();
  });

  it("registers and retrieves declarations by key", () => {
    registerCoreDeclaration("a", SAMPLE_DECL);
    expect(getCoreDeclaration("a")).toBe(SAMPLE_DECL);
  });

  it("returns undefined for unknown keys", () => {
    expect(getCoreDeclaration("nope")).toBeUndefined();
  });

  it("rejects empty keys", () => {
    expect(() => registerCoreDeclaration("", SAMPLE_DECL)).toThrow(
      /key must be a non-empty string/,
    );
  });

  it("rejects re-registration with a different declaration", () => {
    registerCoreDeclaration("a", SAMPLE_DECL);
    const other: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "x", event: "x:changed" }],
    };
    expect(() => registerCoreDeclaration("a", other)).toThrow(
      /already registered with a different declaration/,
    );
  });

  it("is idempotent for identical re-registration", () => {
    registerCoreDeclaration("a", SAMPLE_DECL);
    expect(() => registerCoreDeclaration("a", SAMPLE_DECL)).not.toThrow();
  });

  it("unregisterCoreDeclaration removes the entry", () => {
    registerCoreDeclaration("a", SAMPLE_DECL);
    expect(unregisterCoreDeclaration("a")).toBe(true);
    expect(getCoreDeclaration("a")).toBeUndefined();
    expect(unregisterCoreDeclaration("a")).toBe(false);
  });
});
