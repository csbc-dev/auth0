import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AuthShell, currentAuthTransport, releaseAuthTransport } from "../src/shell/AuthShell";
import { isOwnershipError, OWNERSHIP_ERROR_MARKER } from "../src/raiseError";

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

vi.mock("@auth0/auth0-spa-js", () => ({
  createAuth0Client: vi.fn(),
}));

// Mock WebSocket
class MockWebSocket {
  static OPEN = 1;
  static CLOSED = 3;

  url: string;
  protocols: string | string[];
  readyState = MockWebSocket.OPEN;
  private _listeners: Record<string, ((...args: any[]) => void)[]> = {};
  /** Messages sent via send() — for test assertions. */
  sentMessages: string[] = [];
  /** Handler to simulate server responses after send(). */
  onSend: ((data: string) => void) | null = null;

  constructor(url: string, protocols?: string | string[]) {
    this.url = url;
    this.protocols = protocols ?? "";
    // Auto-fire "open" event on next tick
    queueMicrotask(() => this._emit("open"));
  }

  addEventListener(type: string, listener: (...args: any[]) => void, _opts?: any): void {
    (this._listeners[type] ??= []).push(listener);
  }

  removeEventListener(type: string, listener: (...args: any[]) => void): void {
    const list = this._listeners[type];
    if (list) {
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
    }
  }

  send(data: string): void {
    this.sentMessages.push(data);
    this.onSend?.(data);
  }

  close(): void {
    this.readyState = MockWebSocket.CLOSED;
    this._emit("close");
  }

  /** Test helper: emit an event */
  _emit(type: string, ...args: any[]): void {
    for (const fn of [...(this._listeners[type] ?? [])]) fn(...args);
  }

  /** Test helper: simulate a server message */
  _receiveMessage(data: any): void {
    this._emit("message", { data: JSON.stringify(data) });
  }

  /** Test helper: simulate error */
  _simulateError(): void {
    this._emit("error");
  }
}

vi.stubGlobal("WebSocket", MockWebSocket);

describe("AuthShell", () => {
  let createAuth0Client: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const mod = await import("@auth0/auth0-spa-js");
    createAuth0Client = (mod as any).createAuth0Client;
    createAuth0Client.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extends EventTarget", () => {
    const shell = new AuthShell();
    expect(shell).toBeInstanceOf(EventTarget);
  });

  it("wcBindable has 5 properties (no token)", () => {
    expect(AuthShell.wcBindable.properties).toHaveLength(5);
    const names = AuthShell.wcBindable.properties.map((p) => p.name);
    expect(names).toEqual(["authenticated", "user", "loading", "error", "connected"]);
    expect(names).not.toContain("token");
  });

  it("wcBindable declares flat inputs and transport commands", () => {
    // EventTarget — no attribute surface, so inputs carry no `attribute`.
    const inputs = AuthShell.wcBindable.inputs ?? [];
    expect(inputs.map((i) => i.name)).toEqual([
      "domain",
      "clientId",
      "audience",
      "scope",
      "redirectUri",
      "cacheLocation",
      "useRefreshTokens",
      "mode",
    ]);
    expect(inputs.every((i) => i.attribute === undefined)).toBe(true);

    const commands = AuthShell.wcBindable.commands ?? [];
    expect(commands.map((c) => c.name)).toEqual([
      "login",
      "loginWithPopup",
      "logout",
      "getToken",
      "connect",
      "refreshToken",
      "reconnect",
      "disconnect",
    ]);
    // disconnect() is synchronous; everything else returns a Promise.
    const asyncByName = new Map(commands.map((c) => [c.name, c.async ?? false]));
    expect(asyncByName.get("disconnect")).toBe(false);
    expect(
      commands.filter((c) => c.name !== "disconnect").every((c) => c.async === true),
    ).toBe(true);
  });

  it("initial state is correct", () => {
    const shell = new AuthShell();
    expect(shell.authenticated).toBe(false);
    expect(shell.user).toBeNull();
    expect(shell.loading).toBe(false);
    expect(shell.error).toBeNull();
    expect(shell.connected).toBe(false);
    expect(shell.client).toBeNull();
    expect(shell.token).toBeNull();
  });

  it("initPromise getter returns initialization promise", async () => {
    const mockClient = createMockAuth0Client();
    createAuth0Client.mockResolvedValue(mockClient);

    const shell = new AuthShell();
    const promise = shell.initialize({ domain: "d", clientId: "c", audience: "a" });
    expect(shell.initPromise).toBe(promise);
    await promise;
  });

  describe("initialize", () => {
    it("delegates to AuthCore with correct options", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({
        domain: "test.auth0.com",
        clientId: "client-id",
        audience: "https://api.example.com",
        scope: "openid profile",
        redirectUri: "/callback",
        cacheLocation: "localstorage",
        useRefreshTokens: true,
      });

      expect(createAuth0Client).toHaveBeenCalledWith(
        expect.objectContaining({
          domain: "test.auth0.com",
          clientId: "client-id",
          authorizationParams: expect.objectContaining({
            audience: "https://api.example.com",
            scope: "openid profile",
            redirect_uri: "/callback",
          }),
          cacheLocation: "localstorage",
          useRefreshTokens: true,
        }),
      );
    });

    it("defaults useRefreshTokens to true", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({
        domain: "test.auth0.com",
        clientId: "client-id",
        audience: "https://api.example.com",
      });

      expect(createAuth0Client).toHaveBeenCalledWith(
        expect.objectContaining({ useRefreshTokens: true }),
      );
    });

    it("rolls mode / audience back when initialize() throws synchronously on a missing domain", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("local-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      // A bad attempt that asks for remote mode + an audience…
      expect(() =>
        shell.initialize({ domain: "", clientId: "c", mode: "remote", audience: "bad-aud" }),
      ).toThrow("domain is required.");
      expect(createAuth0Client).not.toHaveBeenCalled();

      // …must not leave the shell in remote mode: the token contract of
      // the previous (local) configuration still applies, so getToken()
      // reports the real precondition instead of "disabled in remote mode".
      expect(shell.mode).toBe("local");
      await expect(shell.getToken()).rejects.toThrow("Auth0 client is not initialized");

      // A subsequent good local-mode attempt behaves as a clean local shell.
      await shell.initialize({ domain: "d", clientId: "c" });
      expect(shell.mode).toBe("local");
      await expect(shell.connect("ws://localhost:3000")).resolves.toBeDefined();
      expect(shell.token).toBe("local-token");
    });
  });

  describe("mode", () => {
    it("defaults to local and exposes token via .token / getToken()", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("local-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      expect(shell.mode).toBe("local");
      expect(shell.token).toBe("local-token");
      await expect(shell.getToken()).resolves.toBe("local-token");
    });

    it("remote mode hides token and blocks getToken()", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("remote-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({
        domain: "d", clientId: "c", audience: "a",
        mode: "remote",
      });

      expect(shell.mode).toBe("remote");
      // Token is held internally (connect() still works), but not readable.
      expect(shell.token).toBeNull();
      await expect(shell.getToken()).rejects.toThrow(
        "getToken() is disabled in remote mode",
      );
    });

    it("remote mode still allows connect() and refresh flow internally", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("handshake-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({
        domain: "d", clientId: "c", audience: "a",
        mode: "remote",
      });

      const transport = await shell.connect("ws://localhost:3000");
      expect(transport).toBeDefined();
      expect(shell.connected).toBe(true);
      // Even after connect, application code must not read the token.
      expect(shell.token).toBeNull();
    });
  });

  describe("login / logout", () => {
    it("delegates login to AuthCore", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.login();

      expect(mockClient.loginWithRedirect).toHaveBeenCalled();
    });

    it("delegates loginWithPopup to AuthCore", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.loginWithPopup();

      expect(mockClient.loginWithPopup).toHaveBeenCalled();
    });

    it("logout closes WebSocket and sets connected=false", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      expect(shell.connected).toBe(true);

      await shell.logout();

      expect(shell.connected).toBe(false);
      expect(mockClient.logout).toHaveBeenCalled();
    });
  });

  describe("connect", () => {
    it("creates WebSocket with token in Sec-WebSocket-Protocol", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("my-jwt-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      const transport = await shell.connect("ws://localhost:3000");

      expect(transport).toBeDefined();
      expect(shell.connected).toBe(true);
    });

    it("throws if client is not initialized", async () => {
      const shell = new AuthShell();
      await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
        "[@csbc-dev/auth0] Auth0 client is not initialized",
      );
    });

    it("throws a friendly error when called with an empty URL", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await expect(shell.connect("")).rejects.toThrow(
        /WebSocket URL is required.*remote-url/,
      );
    });

    it("rejects fast in remote mode when audience is missing", async () => {
      // Without this precondition the missing audience would only
      // surface as a 1008 Unauthorized close from the server's
      // verifyAuth0Token, far from the connect() call site and via
      // a generic "WebSocket connection failed" error that points
      // at the URL instead of the missing attribute. Failing here
      // keeps the diagnostic next to the configuration mistake.
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({
        domain: "d",
        clientId: "c",
        mode: "remote",
        // audience intentionally omitted
      });

      await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
        /audience.*required in remote mode/,
      );
    });

    it("does not throw the audience precondition in local mode", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", mode: "local" });

      const transport = await shell.connect("ws://localhost:3000");
      expect(transport).toBeDefined();
    });

    it("throws if token cannot be obtained", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue(null),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
        "[@csbc-dev/auth0] Failed to obtain access token.",
      );
    });

    it("preserves the error contract when getTokenSilently rejects during connect", async () => {
      // Auth0 SDK rejects during connect()'s token fetch.
      // The contract from the pre-fetchToken era must hold:
      //   1. core.error is updated to the SDK error
      //   2. auth0-gate:error event fires
      //   3. connect() rejects with the domain-specific message
      //      "Failed to obtain access token.", not the raw SDK message
      const sdkError = new Error("login_required");
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockRejectedValue(sdkError),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      const errorEvents: any[] = [];
      shell.addEventListener("auth0-gate:error", (e) => {
        errorEvents.push((e as CustomEvent).detail);
      });

      await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
        "[@csbc-dev/auth0] Failed to obtain access token.",
      );

      expect(shell.error).toBe(sdkError);
      // error event sequence: cleared (null) at start, then SDK error
      expect(errorEvents).toEqual([null, sdkError]);
    });

    describe("failIfConnected (atomic ownership guard)", () => {
      it("rejects fast when an open connection already exists", async () => {
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn().mockResolvedValue("token"),
        });
        createAuth0Client.mockResolvedValue(mockClient);

        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        await shell.connect("ws://localhost:3000");
        expect(shell.connected).toBe(true);

        await expect(
          shell.connect("ws://localhost:3001", { failIfConnected: true }),
        ).rejects.toThrow(/Connection Ownership/);
      });

      // Cycle 7 (I-003): AuthSession previously recognised ownership
      // violations by `message.includes("§3.7")`, which would silently
      // break if the wording ever drifted. The stable identifier is now
      // `_authOwnership === true` on the Error itself. Lock it in here
      // so the producer's contract cannot regress unnoticed.
      it("tags the ownership-violation Error with _authOwnership sentinel (I-003)", async () => {
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn().mockResolvedValue("token"),
        });
        createAuth0Client.mockResolvedValue(mockClient);

        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        await shell.connect("ws://localhost:3000");

        let caught: unknown = null;
        try {
          await shell.connect("ws://localhost:3001", { failIfConnected: true });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Record<string, unknown>)[OWNERSHIP_ERROR_MARKER]).toBe(true);
        expect(isOwnershipError(caught)).toBe(true);
      });

      it("rejects fast when a handshake is already in flight (TOCTOU guard)", async () => {
        // Regression: without `failIfConnected`, a synchronous
        // `auth.connected === false` check followed by `await
        // auth.connect()` was non-atomic — a concurrent connect()
        // could slip into `_closeWebSocket()` and tear down the
        // first caller's socket. The flag now claims ownership
        // synchronously before the first `await`.
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn().mockResolvedValue("token"),
        });
        createAuth0Client.mockResolvedValue(mockClient);

        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        // Caller A: kicks off the first connect but does NOT await yet.
        const pA = shell.connect("ws://localhost:3000");
        // Caller B: runs synchronously BEFORE caller A's microtask
        // boundary. Without the guard, caller B's `_closeWebSocket()`
        // would kill caller A's socket. With the guard, caller B fails
        // fast because `_connectInFlight` is already true.
        await expect(
          shell.connect("ws://localhost:3001", { failIfConnected: true }),
        ).rejects.toThrow(/Connection Ownership/);

        // Caller A still finishes cleanly.
        await expect(pA).resolves.toBeDefined();
        expect(shell.connected).toBe(true);
      });

      it("releases the ownership claim after a successful handshake", async () => {
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn().mockResolvedValue("token"),
        });
        createAuth0Client.mockResolvedValue(mockClient);

        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        await shell.connect("ws://localhost:3000");
        // A second connect WITHOUT the flag is still allowed
        // (take-over semantics for direct callers).
        await expect(
          shell.connect("ws://localhost:3000"),
        ).resolves.toBeDefined();
      });

      it("allows reconnect after the live socket closes (stale _ws must not strand the session)", async () => {
        // Regression: close handler used to leave `_ws` pointing at the
        // already-closed socket. The ownership guard then saw
        // `_ws !== null` and rejected every subsequent
        // `failIfConnected: true` call — which is exactly what
        // <auth0-session> uses, so any server-side close (network
        // blip, server restart, idle timeout) left the session stuck
        // in an unrecoverable error state.
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn().mockResolvedValue("token"),
        });
        createAuth0Client.mockResolvedValue(mockClient);

        // Capture the WebSocket instance so we can emit close manually.
        let wsRef: MockWebSocket | null = null;
        const originalWS = (globalThis as any).WebSocket;
        (globalThis as any).WebSocket = class extends MockWebSocket {
          constructor(url: string, protocols?: string | string[]) {
            super(url, protocols);
            wsRef = this;
          }
        };

        try {
          const shell = new AuthShell();
          await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

          await shell.connect("ws://localhost:3000", { failIfConnected: true });
          expect(shell.connected).toBe(true);
          expect((shell as any)._ws).not.toBeNull();

          // Server-side close — fires the close event on the live socket.
          wsRef!.close();
          expect(shell.connected).toBe(false);
          // The stale reference must have been cleared; otherwise the
          // guard below will falsely report "already owns a connection".
          expect((shell as any)._ws).toBeNull();

          // Reconnect must succeed with the ownership guard enabled.
          const transport = await shell.connect(
            "ws://localhost:3000",
            { failIfConnected: true },
          );
          expect(transport).toBeDefined();
          expect(shell.connected).toBe(true);
        } finally {
          (globalThis as any).WebSocket = originalWS;
        }
      });

      it("releases the ownership claim after a failed handshake", async () => {
        // Regression: if `_connectInFlight` were not reset on error,
        // a subsequent retry with `failIfConnected: true` would falsely
        // report another handshake as in flight.
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn().mockResolvedValue("token"),
        });
        createAuth0Client.mockResolvedValue(mockClient);

        // Install a WebSocket that errors on open.
        const originalWS = (globalThis as any).WebSocket;
        (globalThis as any).WebSocket = class extends MockWebSocket {
          constructor(url: string, protocols?: string | string[]) {
            super(url, protocols);
            queueMicrotask(() => this._emit("error"));
          }
          addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
            // Silently drop "open" so only "error" wins.
            if (type === "open") return;
            super.addEventListener(type, listener, opts);
          }
        };

        try {
          const shell = new AuthShell();
          await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

          await expect(
            shell.connect("ws://localhost:3000", { failIfConnected: true }),
          ).rejects.toThrow(/WebSocket connection failed/);

          // Restore working WS so the retry can succeed.
          (globalThis as any).WebSocket = originalWS;

          await expect(
            shell.connect("ws://localhost:3000", { failIfConnected: true }),
          ).resolves.toBeDefined();
          expect(shell.connected).toBe(true);
        } finally {
          (globalThis as any).WebSocket = originalWS;
        }
      });
    });

    it("clears connected to false when a follow-up connect handshake fails", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let socketCount = 0;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        private _failOpen: boolean;
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          socketCount += 1;
          // 1st socket opens; 2nd socket fails.
          this._failOpen = socketCount === 2;
          if (this._failOpen) {
            queueMicrotask(() => this._emit("error"));
          }
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (this._failOpen && type === "open") return;
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        await shell.connect("ws://localhost:3000");
        expect(shell.connected).toBe(true);

        await expect(shell.connect("ws://localhost:3001")).rejects.toThrow(
          "WebSocket connection failed",
        );

        // Same regression as the reconnect path: a failed follow-up
        // connect must clear `connected` to false instead of leaving
        // the previous `true` value visible after the transport is gone.
        expect(shell.connected).toBe(false);
        // And the failed socket reference must not linger in `_ws` —
        // otherwise subsequent refreshToken()/inspection would see a
        // dead-but-not-null socket.
        expect((shell as any)._ws).toBeNull();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when websocket emits error during connect", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      class ErrorWebSocket {
        static OPEN = 1;
        static CLOSED = 3;
        readyState = ErrorWebSocket.OPEN;
        private _listeners: Record<string, ((...args: any[]) => void)[]> = {};
        constructor(_url: string, _protocols?: string | string[]) {
          queueMicrotask(() => this._emit("error"));
        }
        addEventListener(type: string, listener: (...args: any[]) => void): void {
          (this._listeners[type] ??= []).push(listener);
        }
        removeEventListener(type: string, listener: (...args: any[]) => void): void {
          const list = this._listeners[type] ?? [];
          const idx = list.indexOf(listener);
          if (idx >= 0) list.splice(idx, 1);
        }
        send(_data: string): void {}
        close(): void { this._emit("close"); }
        private _emit(type: string, ...args: any[]): void {
          for (const fn of [...(this._listeners[type] ?? [])]) fn(...args);
        }
      }

      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = ErrorWebSocket;
      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
          "WebSocket connection failed",
        );
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("dispatches connected-changed event", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      const events: boolean[] = [];
      shell.addEventListener("auth0-gate:connected-changed", (e: Event) => {
        events.push((e as CustomEvent).detail);
      });

      await shell.connect("ws://localhost:3000");
      expect(events).toEqual([true]);
    });

    it("sets connected=false when active socket closes", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let wsRef: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          wsRef = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        expect(shell.connected).toBe(true);

        wsRef!._emit("close");
        expect(shell.connected).toBe(false);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });
  });

  describe("reconnect", () => {
    it("refreshes token and returns new transport", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await shell.connect("ws://localhost:3000");
      const newTransport = await shell.reconnect();

      expect(newTransport).toBeDefined();
      expect(shell.connected).toBe(true);
      // getTokenSilently called with cacheMode: "off" for refresh
      expect(mockClient.getTokenSilently).toHaveBeenCalledWith({ cacheMode: "off" });
    });

    it("throws if no previous URL", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await expect(shell.reconnect()).rejects.toThrow(
        "[@csbc-dev/auth0] No previous connection URL",
      );
    });

    it("throws if client is not initialized", async () => {
      const shell = new AuthShell();
      await expect(shell.reconnect()).rejects.toThrow(
        "[@csbc-dev/auth0] Auth0 client is not initialized",
      );
    });

    it("throws when refreshed token is empty", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValueOnce("token").mockResolvedValueOnce(null),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      await expect(shell.reconnect()).rejects.toThrow(
        "[@csbc-dev/auth0] Failed to refresh access token.",
      );
    });

    it("rejects fast in remote mode when audience is missing, before touching the live connection", async () => {
      // Remote mode without `audience` is rejected by the server on `aud`
      // mismatch (1008). reconnect() must fail at the call site instead —
      // without fetching a token, closing the working socket, or putting
      // a token on the wire.
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const sockets: MockWebSocket[] = [];
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      };

      try {
        const shell = new AuthShell();
        // Local mode, no audience: connect() is legal.
        await shell.initialize({ domain: "d", clientId: "c" });
        await shell.connect("ws://localhost:3000");
        expect(shell.connected).toBe(true);
        const tokenFetchesBefore = mockClient.getTokenSilently.mock.calls.length;

        // The deployment is switched to remote mode (e.g. `mode` attribute).
        shell.mode = "remote";

        await expect(shell.reconnect()).rejects.toThrow(
          "reconnect(): `audience` is required in remote mode.",
        );
        expect(mockClient.getTokenSilently.mock.calls.length).toBe(tokenFetchesBefore);
        expect(sockets).toHaveLength(1);
        expect(sockets[0].readyState).toBe(MockWebSocket.OPEN);
        expect(shell.connected).toBe(true);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    describe("ownership guard (shared with connect)", () => {
      it("rejects a second concurrent reconnect() while the first is in flight", async () => {
        // Regression: reconnect() used to skip the in-flight claim, so
        // two parallel calls would both run `_closeWebSocket()` +
        // `new WebSocket(...)`, last-write-wins on `_ws`. The first
        // caller's handshake socket would then be torn down mid-await
        // and its returned transport would be broken while internal
        // state pointed at the second caller's socket.
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn().mockResolvedValue("token"),
        });
        createAuth0Client.mockResolvedValue(mockClient);

        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        // Start two reconnects simultaneously; the second must bail
        // out synchronously (before any await inside reconnect) so
        // the first can complete cleanly.
        const pA = shell.reconnect();
        const rejection = shell.reconnect().catch((err) => err);
        const caught = await rejection;
        expect(caught).toBeInstanceOf(Error);
        expect((caught as Error).message).toMatch(/Connection Ownership/);
        // Cycle 7 (I-003): reconnect ownership error also carries the
        // `_authOwnership` sentinel, same as connect's failIfConnected.
        expect(isOwnershipError(caught)).toBe(true);

        await expect(pA).resolves.toBeDefined();

        // After settling, a subsequent reconnect is allowed again
        // (the ownership claim was released in finally).
        await expect(shell.reconnect()).resolves.toBeDefined();
      });

      it("rejects connect(failIfConnected) while a reconnect is in flight", async () => {
        // Cross-op race: AuthSession's reconnection path may call
        // connect(failIfConnected: true) while application code or an
        // internal retry has started a reconnect(). The atomic claim
        // must block both sides from racing _closeWebSocket().
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn().mockResolvedValue("token"),
        });
        createAuth0Client.mockResolvedValue(mockClient);

        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        const reconnectP = shell.reconnect();
        await expect(
          shell.connect("ws://localhost:3000", { failIfConnected: true }),
        ).rejects.toThrow(/Connection Ownership/);
        await expect(reconnectP).resolves.toBeDefined();
      });

      it("releases the ownership claim after a failed reconnect", async () => {
        // Regression: if reconnect() threw without clearing
        // `_connectInFlight` a subsequent connect(failIfConnected:true)
        // or reconnect() would falsely report an in-flight handshake.
        const mockClient = createMockAuth0Client({
          getTokenSilently: vi.fn()
            .mockResolvedValueOnce("token") // initial connect
            .mockResolvedValueOnce(null),   // reconnect's fetchFreshToken fails
        });
        createAuth0Client.mockResolvedValue(mockClient);

        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        await expect(shell.reconnect()).rejects.toThrow(
          /Failed to refresh access token/,
        );

        // Subsequent reconnect must be admitted now that the flag was
        // released in finally.
        mockClient.getTokenSilently.mockResolvedValueOnce("token2");
        await expect(shell.reconnect()).resolves.toBeDefined();
      });
    });

    it("clears connected to false when reconnect handshake fails", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let socketCount = 0;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        private _failOpen: boolean;
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          socketCount += 1;
          // 1st socket (connect) opens; 2nd socket (reconnect) fails.
          this._failOpen = socketCount === 2;
          if (this._failOpen) {
            queueMicrotask(() => this._emit("error"));
          }
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (this._failOpen && type === "open") return;
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        await shell.connect("ws://localhost:3000");
        expect(shell.connected).toBe(true);

        const events: boolean[] = [];
        shell.addEventListener("auth0-gate:connected-changed", (e: Event) => {
          events.push((e as CustomEvent).detail);
        });

        await expect(shell.reconnect()).rejects.toThrow("WebSocket reconnection failed");

        // The reviewer's exact regression: after a failed reconnect,
        // `connected` must NOT remain stuck at true.
        expect(shell.connected).toBe(false);
        // And subscribers to `auth0-gate:connected-changed` must learn
        // about the transition, otherwise UI / retry logic that keys
        // off `connected` will not react.
        expect(events).toContain(false);
        // The failed socket reference must not linger in `_ws`.
        expect((shell as any)._ws).toBeNull();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when websocket emits error during reconnect", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      class FlakyWebSocket {
        static OPEN = 1;
        static CLOSED = 3;
        static count = 0;
        readyState = FlakyWebSocket.OPEN;
        private _listeners: Record<string, ((...args: any[]) => void)[]> = {};

        constructor(_url: string, _protocols?: string | string[]) {
          FlakyWebSocket.count += 1;
          const eventType = FlakyWebSocket.count === 1 ? "open" : "error";
          queueMicrotask(() => this._emit(eventType));
        }

        addEventListener(type: string, listener: (...args: any[]) => void): void {
          (this._listeners[type] ??= []).push(listener);
        }

        removeEventListener(type: string, listener: (...args: any[]) => void): void {
          const list = this._listeners[type] ?? [];
          const idx = list.indexOf(listener);
          if (idx >= 0) list.splice(idx, 1);
        }

        send(_data: string): void {}

        close(): void {
          this.readyState = FlakyWebSocket.CLOSED;
          this._emit("close");
        }

        private _emit(type: string, ...args: any[]): void {
          for (const fn of [...(this._listeners[type] ?? [])]) fn(...args);
        }
      }

      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = FlakyWebSocket;
      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        await expect(shell.reconnect()).rejects.toThrow("WebSocket reconnection failed");
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("sets connected=false when reconnected socket closes", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let wsRef: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          wsRef = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        await shell.reconnect();
        expect(shell.connected).toBe(true);

        wsRef!._emit("close");
        expect(shell.connected).toBe(false);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("ignores close event from stale socket after reconnect", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const sockets: MockWebSocket[] = [];
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        await shell.reconnect();
        await shell.reconnect();
        expect(shell.connected).toBe(true);

        // sockets[1] is stale after the second reconnect.
        sockets[1]._emit("close");
        expect(shell.connected).toBe(true);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });
  });

  describe("superseded handshakes (teardown racing connect / reconnect)", () => {
    // `disconnect()` / `logout()` / an actual `mode` change bump the
    // connect generation. A connect()/reconnect() that observes the bump
    // on its next await boundary must abandon the session it was
    // building: no token on the wire after the teardown, no
    // `connected=true`, no committed token, no reusable URL.
    const jwt = (sub: string, exp: number): string => {
      const seg = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
      return `${seg({ alg: "RS256" })}.${seg({ sub, exp })}.sig`;
    };
    const EXP_1 = 2_000_000_000;
    const EXP_2 = 2_000_000_600;

    let sockets: TrackedSocket[];
    let interjectOnOpen: (() => void) | null;
    let originalWS: unknown;

    class TrackedSocket extends MockWebSocket {
      closeCalls: unknown[][] = [];
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols);
        sockets.push(this);
      }
      addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
        super.addEventListener(type, listener, opts);
        // Queue the interjection right AFTER the shell's own `open`
        // handler: it runs once the handshake promise has resolved but
        // before connect()/reconnect() resumes past its `await`.
        if (type === "open" && interjectOnOpen) {
          const interject = interjectOnOpen;
          interjectOnOpen = null;
          super.addEventListener("open", interject);
        }
      }
      // Like a real WebSocket, close() only starts the closing handshake;
      // the `close` event arrives on a later task. (The base mock fires it
      // synchronously, which would let the shell's close handler mask
      // state the supersede guards are responsible for.)
      close(...args: unknown[]): void {
        this.closeCalls.push(args);
        if (this.readyState !== MockWebSocket.OPEN) return;
        this.readyState = 2; // CLOSING
        setTimeout(() => {
          this.readyState = MockWebSocket.CLOSED;
          this._emit("close");
        }, 0);
      }
    }

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    }

    async function initShell(getTokenSilently: ReturnType<typeof vi.fn>) {
      const mockClient = createMockAuth0Client({ getTokenSilently });
      createAuth0Client.mockResolvedValue(mockClient);
      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      const connectedEvents: boolean[] = [];
      shell.addEventListener("auth0-gate:connected-changed", (e: Event) => {
        connectedEvents.push((e as CustomEvent).detail);
      });
      return { shell, mockClient, connectedEvents };
    }

    beforeEach(() => {
      sockets = [];
      interjectOnOpen = null;
      originalWS = (globalThis as any).WebSocket;
      (globalThis as any).WebSocket = TrackedSocket;
    });

    afterEach(() => {
      (globalThis as any).WebSocket = originalWS;
    });

    it("connect(): a logout() during the token fetch aborts before any socket is opened", async () => {
      const token = deferred<string>();
      const { shell, connectedEvents } = await initShell(vi.fn(() => token.promise));

      const pending = shell.connect("ws://localhost:3000");
      await new Promise((r) => setTimeout(r, 0)); // now parked in fetchToken()
      await shell.logout();
      token.resolve(jwt("u", EXP_1));

      await expect(pending).rejects.toThrow(
        "connect(): superseded by disconnect()/logout() during token fetch.",
      );
      // The token obtained for the torn-down session never reached the wire.
      expect(sockets).toHaveLength(0);
      expect(shell.connected).toBe(false);
      expect(connectedEvents).not.toContain(true);
      expect(shell.token).toBeNull();
      expect(shell.getTokenExpiry()).toBeNull();
    });

    it("connect(): a disconnect() between `open` and resume closes the socket and rejects without committing", async () => {
      const { shell, connectedEvents } = await initShell(
        vi.fn().mockResolvedValue(jwt("u", EXP_1)),
      );
      interjectOnOpen = () => shell.disconnect();

      await expect(shell.connect("ws://localhost:3000")).rejects.toThrow(
        "connect(): superseded by disconnect()/logout() during handshake.",
      );

      expect(sockets).toHaveLength(1);
      expect(sockets[0].closeCalls[0]).toEqual([1000, "Client disconnect"]);
      expect(shell.connected).toBe(false);
      expect(connectedEvents).not.toContain(true);
      // Token was never committed …
      expect(shell.token).toBeNull();
      expect(shell.getTokenExpiry()).toBeNull();
      // … and the abandoned URL was rolled back, so reconnect() has no
      // previous URL to reuse.
      await expect(shell.reconnect()).rejects.toThrow("No previous connection URL");
    });

    it("connect(): a mode flip between `open` and resume closes the fresh socket itself and drops a stale connected=true", async () => {
      const { shell, connectedEvents } = await initShell(
        vi.fn()
          .mockResolvedValueOnce(jwt("u", EXP_1))
          .mockResolvedValueOnce(jwt("u", EXP_2))
          .mockResolvedValue(jwt("u", EXP_2)),
      );
      // A live connection exists …
      await shell.connect("ws://first.example");
      expect(shell.connected).toBe(true);
      expect(shell.getTokenExpiry()).toBe(EXP_1 * 1000);

      // … and a take-over connect() is superseded by a `mode` change
      // (which, unlike disconnect/logout, does not close anything itself).
      interjectOnOpen = () => {
        shell.mode = "remote";
      };
      await expect(shell.connect("ws://second.example")).rejects.toThrow(
        "connect(): superseded by disconnect()/logout() during handshake.",
      );

      // The guard owns the cleanup: it closes the just-opened socket with
      // a normal-closure code …
      expect(sockets).toHaveLength(2);
      expect(sockets[1].closeCalls).toEqual([[1000, "Superseded by disconnect/logout"]]);
      // … does not keep advertising the replaced connection …
      expect(shell.connected).toBe(false);
      expect(connectedEvents).toEqual([true, false]);
      // … and the superseding token was not committed.
      expect(shell.getTokenExpiry()).toBe(EXP_1 * 1000);

      // No socket reference / stale `connected` lingers (the replacement's
      // `close` event has not even arrived yet): an ownership-guarded
      // connect — what <auth0-session> uses — is admitted, not rejected as
      // "target already owns a connection".
      await expect(
        shell.connect("ws://third.example", { failIfConnected: true }),
      ).resolves.toBeDefined();
      expect(shell.connected).toBe(true);
    });

    it("reconnect(): a disconnect() during the token fetch aborts before a replacement socket is opened", async () => {
      const fresh = deferred<string>();
      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(jwt("u", EXP_1))
        .mockImplementationOnce(() => fresh.promise);
      const { shell } = await initShell(getTokenSilently);
      await shell.connect("ws://localhost:3000");

      const pending = shell.reconnect();
      await new Promise((r) => setTimeout(r, 0)); // parked in fetchFreshToken()
      shell.disconnect();
      fresh.resolve(jwt("u", EXP_2));

      await expect(pending).rejects.toThrow(
        "reconnect(): superseded by disconnect()/logout() during token fetch.",
      );
      expect(sockets).toHaveLength(1);
      expect(shell.connected).toBe(false);
      expect(shell.getTokenExpiry()).toBe(EXP_1 * 1000);
    });

    it("reconnect(): a disconnect() between `open` and resume closes the socket and rejects without committing", async () => {
      const { shell } = await initShell(
        vi.fn()
          .mockResolvedValueOnce(jwt("u", EXP_1))
          .mockResolvedValueOnce(jwt("u", EXP_2)),
      );
      await shell.connect("ws://localhost:3000");
      interjectOnOpen = () => shell.disconnect();

      await expect(shell.reconnect()).rejects.toThrow(
        "reconnect(): superseded by disconnect()/logout() during handshake.",
      );

      expect(sockets).toHaveLength(2);
      expect(sockets[1].closeCalls[0]).toEqual([1000, "Client disconnect"]);
      expect(shell.connected).toBe(false);
      expect(shell.getTokenExpiry()).toBe(EXP_1 * 1000);
    });

    it("reconnect(): a mode flip between `open` and resume closes the fresh socket itself and drops a stale connected=true", async () => {
      const { shell, connectedEvents } = await initShell(
        vi.fn()
          .mockResolvedValueOnce(jwt("u", EXP_1))
          .mockResolvedValueOnce(jwt("u", EXP_2))
          .mockResolvedValue(jwt("u", EXP_2)),
      );
      await shell.connect("ws://localhost:3000");
      interjectOnOpen = () => {
        shell.mode = "remote";
      };

      await expect(shell.reconnect()).rejects.toThrow(
        "reconnect(): superseded by disconnect()/logout() during handshake.",
      );

      expect(sockets).toHaveLength(2);
      // The previous socket was closed by reconnect() itself; the
      // replacement is closed by the supersede guard.
      expect(sockets[0].closeCalls).toEqual([[1000, "Client disconnect"]]);
      expect(sockets[1].closeCalls).toEqual([[1000, "Superseded by disconnect/logout"]]);
      await expect(shell.refreshToken()).rejects.toThrow("No active connection");
      expect(shell.connected).toBe(false);
      expect(connectedEvents).toEqual([true, false]);
      expect(shell.getTokenExpiry()).toBe(EXP_1 * 1000);

      // With no socket reference / stale `connected=true` left behind
      // (the replacement's `close` event has not even arrived yet), an
      // ownership-guarded connect (what <auth0-session> uses) is admitted
      // instead of being rejected as "target already owns a connection".
      await expect(
        shell.connect("ws://localhost:3000", { failIfConnected: true }),
      ).resolves.toBeDefined();
      expect(shell.connected).toBe(true);
    });

    // The owner of the connection a reconnect() is replacing gives it
    // back (`releaseAuthTransport()`, what <auth0-session> does when it
    // ends). The release cannot cancel the handshake; the reconnect must
    // not hand a connection to an owner that is gone.
    it("reconnect(): a release of the connection it replaces during the token fetch closes that connection at once; the reconnect opens nothing and rejects", async () => {
      const fresh = deferred<string>();
      const { shell, connectedEvents } = await initShell(
        vi.fn()
          .mockResolvedValueOnce(jwt("u", EXP_1))
          .mockImplementationOnce(() => fresh.promise)
          .mockResolvedValue(jwt("u", EXP_2)),
      );
      const transport = await shell.connect("ws://localhost:3000", { failIfConnected: true });

      const pending = shell.reconnect(); // parked in fetchFreshToken()
      const released = releaseAuthTransport(transport);

      expect(released).toBeInstanceOf(Promise);
      expect(sockets[0].closeCalls).toEqual([[1000, "Client disconnect"]]);
      expect(shell.connected).toBe(false);
      expect(connectedEvents).toEqual([true, false]);
      let settled = false;
      void (released as Promise<void>).then(() => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false); // the reconnect still holds the slot

      fresh.resolve(jwt("u", EXP_2));
      await expect(pending).rejects.toThrow(
        "reconnect(): superseded by the release of the connection it was replacing, during token fetch.",
      );
      await released;
      expect(settled).toBe(true);
      expect(sockets).toHaveLength(1);
      expect(connectedEvents).toEqual([true, false]);
      expect(shell.getTokenExpiry()).toBe(EXP_1 * 1000);
      // Released once; the slot is free for the next owner.
      expect(releaseAuthTransport(transport)).toBe(false);
      await expect(
        shell.connect("ws://localhost:3000", { failIfConnected: true }),
      ).resolves.toBeDefined();
    });

    it("reconnect(): a release of the connection it replaces during the handshake publishes connected=false at once; the replacement is closed when it opens and the reconnect rejects", async () => {
      const { shell, connectedEvents } = await initShell(
        vi.fn()
          .mockResolvedValueOnce(jwt("u", EXP_1))
          .mockResolvedValue(jwt("u", EXP_2)),
      );
      const transport = await shell.connect("ws://localhost:3000", { failIfConnected: true });
      let released: boolean | Promise<void> | undefined;
      let connectedAtRelease: boolean | undefined;
      interjectOnOpen = () => {
        released = releaseAuthTransport(transport);
        connectedAtRelease = shell.connected;
      };

      await expect(shell.reconnect()).rejects.toThrow(
        "reconnect(): superseded by the release of the connection it was replacing, during handshake.",
      );

      expect(released).toBeInstanceOf(Promise);
      expect(connectedAtRelease).toBe(false);
      expect(sockets).toHaveLength(2);
      // The reconnect closed the old socket; the replacement is closed by
      // the supersede guard. Nothing is closed or announced twice.
      expect(sockets[0].closeCalls).toEqual([[1000, "Client disconnect"]]);
      expect(sockets[1].closeCalls).toEqual([[1000, "Superseded by connection release"]]);
      expect(shell.connected).toBe(false);
      expect(connectedEvents).toEqual([true, false]);
      expect(shell.getTokenExpiry()).toBe(EXP_1 * 1000);
      await released;
      await expect(
        shell.connect("ws://localhost:3000", { failIfConnected: true }),
      ).resolves.toBeDefined();
    });

    it("reconnect(): a disconnect() during the handshake is reported as the cause even when the owner also released the connection", async () => {
      const { shell, connectedEvents } = await initShell(
        vi.fn()
          .mockResolvedValueOnce(jwt("u", EXP_1))
          .mockResolvedValue(jwt("u", EXP_2)),
      );
      const transport = await shell.connect("ws://localhost:3000", { failIfConnected: true });
      interjectOnOpen = () => {
        shell.disconnect();
        releaseAuthTransport(transport);
      };

      await expect(shell.reconnect()).rejects.toThrow(
        "reconnect(): superseded by disconnect()/logout() during handshake.",
      );
      expect(connectedEvents).toEqual([true, false]);
    });
  });

  describe("refreshToken (in-band refresh)", () => {
    it("sends auth:refresh command over the existing WebSocket", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      // Capture the WS instance to simulate server response
      const wsInstances = (globalThis as any).WebSocket as typeof MockWebSocket;
      // The last created MockWebSocket is the one used by connect()
      // We need to get it — use onSend to intercept
      let capturedWs: MockWebSocket | null = null;

      // Re-connect to get a fresh WS we can instrument
      const origWS = globalThis.WebSocket;
      let lastWs: MockWebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          lastWs = this;
        }
      };

      // Reconnect to get instrumented WS
      await shell.reconnect();
      capturedWs = lastWs!;
      (globalThis as any).WebSocket = origWS;

      // Set up auto-respond on send
      capturedWs.onSend = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.name === "auth:refresh") {
          queueMicrotask(() => {
            capturedWs!._receiveMessage({ type: "return", id: msg.id, value: undefined });
          });
        }
      };

      // Now refreshToken should succeed
      await shell.refreshToken();

      // Verify the sent message
      const sent = capturedWs.sentMessages.map((s) => JSON.parse(s));
      const refreshMsg = sent.find((m: any) => m.name === "auth:refresh");
      expect(refreshMsg).toBeDefined();
      expect(refreshMsg.type).toBe("cmd");
      expect(refreshMsg.args[0]).toBe("token"); // the refreshed token
    });

    it("does not forward auth:refresh replies to the transport consumer", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        const transport = await shell.connect("ws://localhost:3000");

        const forwarded: any[] = [];
        transport.onMessage((message) => {
          forwarded.push(message);
        });

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._receiveMessage({ type: "return", id: "unrelated", value: 1 });
              capturedWs!._receiveMessage({ type: "return", id: msg.id, value: undefined });
            });
          }
        };

        await shell.refreshToken();

        expect(forwarded).toEqual([{ type: "return", id: "unrelated", value: 1 }]);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when server returns throw", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      // Instrument WS
      let capturedWs: MockWebSocket;
      const origWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };
      await shell.connect("ws://localhost:3000");
      (globalThis as any).WebSocket = origWS;

      capturedWs!.onSend = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.name === "auth:refresh") {
          queueMicrotask(() => {
            capturedWs._receiveMessage({
              type: "throw",
              id: msg.id,
              error: { name: "Error", message: "Token refresh failed" },
            });
          });
        }
      };

      await expect(shell.refreshToken()).rejects.toThrow("Token refresh failed");
    });

    it("falls back to a generic message when server throw payload has no message", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._receiveMessage({ type: "throw", id: msg.id, error: "opaque" });
            });
          }
        };

        await expect(shell.refreshToken()).rejects.toThrow("Token refresh failed");
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("uses default message when throw payload has no error.message", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      let capturedWs: MockWebSocket;
      const origWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };
      await shell.connect("ws://localhost:3000");
      (globalThis as any).WebSocket = origWS;

      capturedWs!.onSend = (data: string) => {
        const msg = JSON.parse(data);
        if (msg.name === "auth:refresh") {
          queueMicrotask(() => {
            capturedWs._receiveMessage({ type: "throw", id: msg.id });
          });
        }
      };

      await expect(shell.refreshToken()).rejects.toThrow("Token refresh failed");
    });

    it("throws if no active connection", async () => {
      const mockClient = createMockAuth0Client();
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      await expect(shell.refreshToken()).rejects.toThrow(
        "[@csbc-dev/auth0] No active connection",
      );
    });

    it("throws if the socket is open but no transport is registered", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      (shell as any)._transport = null;

      await expect(shell.refreshToken()).rejects.toThrow(
        "[@csbc-dev/auth0] No active connection. Call connect() first.",
      );
    });

    it("throws if client is not initialized", async () => {
      const shell = new AuthShell();
      await expect(shell.refreshToken()).rejects.toThrow(
        "[@csbc-dev/auth0] Auth0 client is not initialized",
      );
    });

    it("throws if refreshed token is empty", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValueOnce("token").mockResolvedValueOnce(null),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      await expect(shell.refreshToken()).rejects.toThrow(
        "[@csbc-dev/auth0] Failed to refresh access token.",
      );
    });

    it("ignores malformed or unrelated websocket messages", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._emit("message", { data: "not-json" });
              capturedWs!._receiveMessage({ type: "return", id: "other-id", value: undefined });
              capturedWs!._receiveMessage({ type: "return", id: msg.id, value: undefined });
            });
          }
        };

        await expect(shell.refreshToken()).resolves.toBeUndefined();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when websocket closes before refresh response", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => capturedWs!.close());
          }
        };

        await expect(shell.refreshToken()).rejects.toThrow(
          "WebSocket closed before token refresh completed",
        );
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when websocket errors before refresh response", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => capturedWs!._simulateError());
          }
        };

        await expect(shell.refreshToken()).rejects.toThrow(
          "WebSocket error during token refresh",
        );
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("cleans up safely when close fires before send throws synchronously", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }

        override send(data: string): void {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            this._emit("close");
            throw new Error("send failed after close");
          }
          super.send(data);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        await expect(shell.refreshToken()).rejects.toThrow(
          "WebSocket closed before token refresh completed",
        );

        expect(capturedWs!.readyState).toBe(MockWebSocket.OPEN);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("rejects when refresh response times out", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            // Intentionally do not send any response.
          }
        };

        vi.useFakeTimers();
        try {
          const refreshPromise = shell.refreshToken();
          const rejectionAssertion = expect(refreshPromise).rejects.toThrow("Token refresh timed out");
          await vi.advanceTimersByTimeAsync(30_000);
          await rejectionAssertion;
        } finally {
          vi.useRealTimers();
        }
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("cleans up timer and listeners when ws.send throws synchronously", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let capturedWs: MockWebSocket | null = null;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        // Make ws.send throw synchronously to simulate a socket that
        // transitioned out of OPEN between readyState check and send.
        capturedWs!.onSend = () => {
          throw new Error("send failed synchronously");
        };

        // Snapshot listeners that pre-exist refreshToken (e.g. the
        // connect()-installed long-lived close handler), so we can
        // assert refreshToken's three listeners were removed without
        // accidentally requiring removal of unrelated handlers.
        const listenersBefore = {
          message: (capturedWs as any)._listeners["message"]?.length ?? 0,
          close: (capturedWs as any)._listeners["close"]?.length ?? 0,
          error: (capturedWs as any)._listeners["error"]?.length ?? 0,
        };

        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
        const setTimeoutsBefore = setTimeoutSpy.mock.calls.length;

        await expect(shell.refreshToken()).rejects.toThrow("send failed synchronously");

        // The 30-second refresh timer must have been cleared, not left pending.
        const newTimers = setTimeoutSpy.mock.results.slice(setTimeoutsBefore);
        for (const result of newTimers) {
          expect(clearTimeoutSpy).toHaveBeenCalledWith(result.value);
        }

        // refreshToken's three listeners must have been removed too,
        // otherwise an unrelated future frame could be misattributed.
        const listenersAfter = {
          message: (capturedWs as any)._listeners["message"]?.length ?? 0,
          close: (capturedWs as any)._listeners["close"]?.length ?? 0,
          error: (capturedWs as any)._listeners["error"]?.length ?? 0,
        };
        expect(listenersAfter).toEqual(listenersBefore);

        setTimeoutSpy.mockRestore();
        clearTimeoutSpy.mockRestore();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("wraps non-Error ws.send failures", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let capturedWs: MockWebSocket | null = null;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        capturedWs!.onSend = () => {
          throw "string failure";
        };

        await expect(shell.refreshToken()).rejects.toThrow("string failure");
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });
  });

  describe("getTokenExpiry stays in sync across refresh / reconnect", () => {
    function makeJwt(payload: Record<string, unknown>): string {
      const toBase64Url = (s: string) =>
        Buffer.from(s).toString("base64")
          .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      const header = toBase64Url(JSON.stringify({ alg: "RS256" }));
      const body = toBase64Url(JSON.stringify(payload));
      return `${header}.${body}.sig`;
    }

    it("refreshToken() updates the token source read by getTokenExpiry()", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const refreshedExp = originalExp + 3600;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const refreshedToken = makeJwt({ sub: "u", exp: refreshedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken) // for _syncState at init
        .mockResolvedValueOnce(originalToken) // for connect()
        .mockResolvedValueOnce(refreshedToken); // for refreshToken()

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let capturedWs: MockWebSocket | null = null;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        // Before refresh: getTokenExpiry reflects original token.
        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._receiveMessage({ type: "return", id: msg.id, value: undefined });
            });
          }
        };

        await shell.refreshToken();

        // After refresh: getTokenExpiry MUST reflect the refreshed token.
        // Otherwise exp-based schedulers see a past-due exp and busy-loop.
        expect(shell.getTokenExpiry()).toBe(refreshedExp * 1000);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("connect() does NOT advance getTokenExpiry() when the WebSocket fails to open", async () => {
      const candidateExp = Math.floor(Date.now() / 1000) + 60;
      const candidateToken = makeJwt({ sub: "u", exp: candidateExp });

      // Only one fetch should happen — connect()'s — and we want it to
      // produce a token whose exp must NOT leak into AuthCore on failure.
      const getTokenSilently = vi.fn().mockResolvedValue(candidateToken);

      const mockClient = createMockAuth0Client({
        // isAuthenticated=false so initialize() does NOT itself sync a token
        // via _syncState — that way the only candidate for _token is the one
        // connect() fetches.
        isAuthenticated: vi.fn().mockResolvedValue(false),
        getUser: vi.fn().mockResolvedValue(null),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        private _failOpen = true;
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          // First and only socket: refuse to open.
          queueMicrotask(() => this._emit("error"));
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (this._failOpen && type === "open") return;
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        // Sanity: nothing committed yet.
        expect(shell.getTokenExpiry()).toBeNull();

        await expect(shell.connect("ws://localhost:3000")).rejects.toThrow();

        // Connection failed — `_token` must not have been published,
        // otherwise schedulers would see a future `exp` even though
        // the server never accepted the token.
        expect(shell.getTokenExpiry()).toBeNull();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });
    it("connect() rejects cleanly when the socket closes before the error event", async () => {
      const candidateToken = makeJwt({ sub: "u", exp: Math.floor(Date.now() / 1000) + 60 });
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(false),
        getUser: vi.fn().mockResolvedValue(null),
        getTokenSilently: vi.fn().mockResolvedValue(candidateToken),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          queueMicrotask(() => {
            this._emit("close");
            this._emit("error");
          });
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (type === "open") return;
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await expect(shell.connect("ws://localhost:3000")).rejects.toThrow();
        expect(shell.connected).toBe(false);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("connect() rolls getTokenExpiry() back when the server closes with 1008 after open", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const rejectedExp = originalExp + 3600;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const rejectedToken = makeJwt({ sub: "u", exp: rejectedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(rejectedToken);

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let capturedWs: MockWebSocket | null = null;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

        await shell.connect("ws://localhost:3000");
        expect(shell.getTokenExpiry()).toBe(rejectedExp * 1000);

        capturedWs!._emit("close", { code: 1008 });
        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("refreshToken() does NOT advance getTokenExpiry() when the server rejects", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const refreshedExp = originalExp + 3600;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const refreshedToken = makeJwt({ sub: "u", exp: refreshedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken) // _syncState
        .mockResolvedValueOnce(originalToken) // connect()
        .mockResolvedValueOnce(refreshedToken); // refreshToken() — will be rejected by server

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let capturedWs: MockWebSocket | null = null;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

        capturedWs!.onSend = (data: string) => {
          const msg = JSON.parse(data);
          if (msg.name === "auth:refresh") {
            queueMicrotask(() => {
              capturedWs!._receiveMessage({
                type: "throw",
                id: msg.id,
                error: { name: "Error", message: "Token refresh hook failed" },
              });
            });
          }
        };

        await expect(shell.refreshToken()).rejects.toThrow();

        // Server rejected — `_token` (and therefore getTokenExpiry)
        // must still reflect the token the server previously accepted,
        // not the one we speculatively fetched from Auth0.
        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("reconnect() does NOT advance getTokenExpiry() when the new WebSocket fails to open", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const refreshedExp = originalExp + 7200;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const refreshedToken = makeJwt({ sub: "u", exp: refreshedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(refreshedToken);

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let newSocketCount = 0;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        private _failOpen: boolean;
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          newSocketCount += 1;
          // The reconnect() socket — the second one — must fail to open.
          this._failOpen = newSocketCount === 2;
          if (this._failOpen) {
            queueMicrotask(() => this._emit("error"));
          }
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (this._failOpen && type === "open") return; // drop the open handler so it cannot resolve
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

        await expect(shell.reconnect()).rejects.toThrow();

        // Reconnection failed — `_token` must not have been published.
        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("reconnect() updates the token source read by getTokenExpiry()", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const refreshedExp = originalExp + 7200;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const refreshedToken = makeJwt({ sub: "u", exp: refreshedExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken) // _syncState at init
        .mockResolvedValueOnce(originalToken) // connect()
        .mockResolvedValueOnce(refreshedToken); // reconnect()

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      await shell.connect("ws://localhost:3000");

      expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

      await shell.reconnect();

      expect(shell.getTokenExpiry()).toBe(refreshedExp * 1000);
    });

    it("reconnect() rolls getTokenExpiry() back when the replacement socket closes with 1008", async () => {
      const originalExp = Math.floor(Date.now() / 1000) + 60;
      const replacementExp = originalExp + 7200;

      const originalToken = makeJwt({ sub: "u", exp: originalExp });
      const replacementToken = makeJwt({ sub: "u", exp: replacementExp });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(replacementToken);

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      const sockets: MockWebSocket[] = [];
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");

        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);

        await shell.reconnect();
        expect(shell.getTokenExpiry()).toBe(replacementExp * 1000);

        sockets[1]!._emit("close", { code: 1008 });
        expect(shell.getTokenExpiry()).toBe(originalExp * 1000);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });
    it("reconnect() rejects cleanly when the replacement socket closes before the error event", async () => {
      const originalToken = makeJwt({ sub: "u", exp: Math.floor(Date.now() / 1000) + 60 });
      const replacementToken = makeJwt({ sub: "u", exp: Math.floor(Date.now() / 1000) + 120 });

      const getTokenSilently = vi.fn()
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(originalToken)
        .mockResolvedValueOnce(replacementToken);

      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently,
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const originalWS = globalThis.WebSocket;
      let socketCount = 0;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          socketCount += 1;
          if (socketCount === 2) {
            queueMicrotask(() => {
              this._emit("close");
              this._emit("error");
            });
          }
        }
        addEventListener(type: string, listener: (...args: any[]) => void, opts?: any): void {
          if (socketCount === 2 && type === "open") return;
          super.addEventListener(type, listener, opts);
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        await shell.connect("ws://localhost:3000");
        await expect(shell.reconnect()).rejects.toThrow();
        expect(shell.connected).toBe(false);
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });
  });

  describe("events from AuthCore bubble through AuthShell", () => {
    it("authenticated event fires on AuthShell", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("t"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      const events: boolean[] = [];
      shell.addEventListener("auth0-gate:authenticated-changed", (e: Event) => {
        events.push((e as CustomEvent).detail);
      });

      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });

      expect(events).toContain(true);
      expect(shell.authenticated).toBe(true);
    });
  });

  // Defense-in-depth filter: AuthShell wraps AuthCore in a private
  // relay so that `auth0-gate:token-changed` events from AuthCore
  // are dropped before reaching the outer dispatch target whenever
  // the shell is in remote mode. The token must NEVER be observable
  // from imperative DOM listeners on `<auth0-gate>` in remote mode —
  // that's the same contract `AuthShell.wcBindable` enforces by
  // omitting `token` from the declarative surface.
  //
  // These regression tests lock the filter in. The constructor
  // accepts an explicit `target` EventTarget (mirroring how `Auth`
  // passes `this` so the outer DOM element receives the events) and
  // we listen on that outer target.
  describe("token-changed relay filter (cycle-3 fix #5 regression)", () => {
    it("drops auth0-gate:token-changed on the outer target in remote mode", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("remote-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const outer = new EventTarget();
      const tokenEvents: Array<string | null> = [];
      outer.addEventListener("auth0-gate:token-changed", (e: Event) => {
        tokenEvents.push((e as CustomEvent).detail);
      });

      const shell = new AuthShell(outer);
      await shell.initialize({
        domain: "d", clientId: "c", audience: "a",
        mode: "remote",
      });
      // initialize() in remote mode triggers `_setToken("remote-token")`
      // inside AuthCore via `_syncState`, exercising the relay.

      // Drive a further commit to cover the explicit `commitToken` path
      // too (which connect() / refreshToken() use in production).
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (shell as any)._core.commitToken("explicit-remote-token");

      // No token-changed event must escape to the outer target while
      // in remote mode — the relay drops them so DOM observers on
      // <auth0-gate> never see token material.
      expect(tokenEvents).toEqual([]);

      // Sanity: AuthShell's `.token` getter is also `null` in remote
      // mode (the wcBindable + getter contract; orthogonal to the relay
      // but co-validated here so a regression in either fails loudly).
      expect(shell.token).toBeNull();
    });

    it("forwards auth0-gate:token-changed to the outer target in local mode", async () => {
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("local-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const outer = new EventTarget();
      const tokenEvents: Array<string | null> = [];
      outer.addEventListener("auth0-gate:token-changed", (e: Event) => {
        tokenEvents.push((e as CustomEvent).detail);
      });

      const shell = new AuthShell(outer);
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      // mode defaults to "local"; `_setToken("local-token")` runs inside
      // _syncState and the relay forwards it to `outer`.

      expect(tokenEvents).toContain("local-token");
      // Local mode keeps the existing event-with-token contract intact.
      expect(shell.token).toBe("local-token");
    });

    it("drops the token-changed event when mode flips local->remote between commits", async () => {
      // The filter reads `this._mode` at relay-time, not at relay
      // construction. A late switch to remote mode (mirrored from the
      // <auth0-gate mode> attribute via Auth.attributeChangedCallback)
      // must take effect for subsequent token commits — otherwise an
      // app that flips into remote mode mid-session would still leak
      // the token through DOM listeners until the next page reload.
      const mockClient = createMockAuth0Client({
        isAuthenticated: vi.fn().mockResolvedValue(true),
        getUser: vi.fn().mockResolvedValue({ sub: "u" }),
        getTokenSilently: vi.fn().mockResolvedValue("local-token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const outer = new EventTarget();
      const tokenEvents: Array<string | null> = [];
      outer.addEventListener("auth0-gate:token-changed", (e: Event) => {
        tokenEvents.push((e as CustomEvent).detail);
      });

      const shell = new AuthShell(outer);
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      // Local mode commit reaches outer.
      expect(tokenEvents).toEqual(["local-token"]);

      // Flip the shell into remote mode (same path Auth's attribute
      // mirror takes) and commit a new token.
      shell.mode = "remote";
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (shell as any)._core.commitToken("post-flip-token");

      // The post-flip commit must NOT have escaped to the outer target.
      expect(tokenEvents).toEqual(["local-token"]);
    });
  });

  describe("releaseAuthTransport (ownership-checked release)", () => {
    // `<auth0-session>` uses this to give back a connection it opened but
    // could not finish setting up. It may only ever close the connection
    // behind the transport it was handed, and only while that connection
    // is still the shell's live one.
    class RecordingSocket extends MockWebSocket {
      closeCalls: unknown[][] = [];
      close(...args: unknown[]): void {
        this.closeCalls.push(args);
        super.close();
      }
    }

    let sockets: RecordingSocket[];
    let originalWS: unknown;

    beforeEach(() => {
      sockets = [];
      originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends RecordingSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          sockets.push(this);
        }
      };
    });

    afterEach(() => {
      (globalThis as any).WebSocket = originalWS;
    });

    async function initializedShell() {
      createAuth0Client.mockResolvedValue(createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      }));
      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      const connectedEvents: boolean[] = [];
      shell.addEventListener("auth0-gate:connected-changed",
        (e) => connectedEvents.push((e as CustomEvent).detail));
      return { shell, connectedEvents };
    }

    it("closes the live connection and publishes connected=false synchronously", async () => {
      const { shell, connectedEvents } = await initializedShell();
      const transport = await shell.connect("ws://localhost:3000", { failIfConnected: true });

      expect(releaseAuthTransport(transport)).toBe(true);

      expect(sockets).toHaveLength(1);
      expect(sockets[0].readyState).toBe(MockWebSocket.CLOSED);
      expect(sockets[0].closeCalls).toEqual([[1000, "Client disconnect"]]);
      expect(shell.connected).toBe(false);
      expect(connectedEvents).toEqual([true, false]);

      // Released once: a second call has nothing left to release.
      expect(releaseAuthTransport(transport)).toBe(false);
      expect(connectedEvents).toEqual([true, false]);

      // The ownership guard no longer sees a connection, so the same
      // owner can connect again.
      await shell.connect("ws://localhost:3000", { failIfConnected: true });
      expect(shell.connected).toBe(true);
      expect(sockets[1].readyState).toBe(MockWebSocket.OPEN);
    });

    it("leaves alone a connection that replaced the transport", async () => {
      const { shell, connectedEvents } = await initializedShell();
      const first = await shell.connect("ws://localhost:3000");
      // A take-over connect closes the first socket and opens its own.
      await shell.connect("ws://localhost:3000");

      expect(releaseAuthTransport(first)).toBe(false);

      expect(sockets).toHaveLength(2);
      expect(sockets[1].readyState).toBe(MockWebSocket.OPEN);
      expect(sockets[1].closeCalls).toEqual([]);
      expect(shell.connected).toBe(true);
      expect(connectedEvents).toEqual([true]);
    });

    it("returns false for a transport the shell did not create, or one already released by disconnect()", async () => {
      const { shell, connectedEvents } = await initializedShell();
      const transport = await shell.connect("ws://localhost:3000");

      expect(releaseAuthTransport({ send: vi.fn(), onMessage: vi.fn() })).toBe(false);
      expect(shell.connected).toBe(true);

      shell.disconnect();
      expect(releaseAuthTransport(transport)).toBe(false);
      expect(connectedEvents).toEqual([true, false]);
    });

    it("does not supersede a take-over handshake that is already in flight (unlike disconnect())", async () => {
      // disconnect() vetoes connections in general (it bumps the connect
      // generation, so a pending connect() rejects as superseded). The
      // release only gives up one specific connection.
      const { shell, connectedEvents } = await initializedShell();
      const first = await shell.connect("ws://localhost:3000");
      const takeOver = shell.connect("ws://localhost:3000"); // awaiting its token

      expect(releaseAuthTransport(first)).toBe(true);
      expect(shell.connected).toBe(false);

      await expect(takeOver).resolves.toBeDefined();
      expect(shell.connected).toBe(true);
      expect(sockets.map((s) => s.readyState)).toEqual([MockWebSocket.CLOSED, MockWebSocket.OPEN]);
      expect(connectedEvents).toEqual([true, false, true]);
    });

    describe("a reconnect() replacement continues the connection it replaced", () => {
      it("follows reconnect() to the replacement: closes it once and publishes connected=false once", async () => {
        const { shell, connectedEvents } = await initializedShell();
        const first = await shell.connect("ws://localhost:3000", { failIfConnected: true });
        const second = await shell.reconnect();
        const third = await shell.reconnect();

        expect(currentAuthTransport(first)).toBe(third);
        expect(currentAuthTransport(second)).toBe(third);
        expect(currentAuthTransport(third)).toBe(third);
        expect(connectedEvents).toEqual([true]);

        expect(releaseAuthTransport(first)).toBe(true);

        expect(sockets.map((s) => s.closeCalls)).toEqual([
          [[1000, "Client disconnect"]],
          [[1000, "Client disconnect"]],
          [[1000, "Client disconnect"]],
        ]);
        expect(shell.connected).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
        // Any transport of the connection leads to the same, now released,
        // connection.
        expect(releaseAuthTransport(second)).toBe(false);
        expect(releaseAuthTransport(third)).toBe(false);
        expect(connectedEvents).toEqual([true, false]);
      });

      it("does not follow a take-over connect(), nor a reconnect() of the take-over's connection", async () => {
        const { shell, connectedEvents } = await initializedShell();
        const first = await shell.connect("ws://localhost:3000");
        await shell.reconnect();
        const takeOver = await shell.connect("ws://localhost:3000");
        const takeOverReplacement = await shell.reconnect();

        expect(currentAuthTransport(takeOver)).toBe(takeOverReplacement);
        expect(releaseAuthTransport(first)).toBe(false);
        expect(sockets[3].closeCalls).toEqual([]);
        expect(shell.connected).toBe(true);
        expect(connectedEvents).toEqual([true]);

        expect(releaseAuthTransport(takeOver)).toBe(true);
        expect(sockets[3].closeCalls).toEqual([[1000, "Client disconnect"]]);
        expect(connectedEvents).toEqual([true, false]);
      });

      it("a reconnect() with no live connection to replace opens a connection of its own", async () => {
        const { shell } = await initializedShell();
        const first = await shell.connect("ws://localhost:3000");
        shell.disconnect();
        const fresh = await shell.reconnect();

        expect(currentAuthTransport(first)).toBe(first);
        expect(releaseAuthTransport(first)).toBe(false);
        expect(shell.connected).toBe(true);
        expect(releaseAuthTransport(fresh)).toBe(true);
        expect(shell.connected).toBe(false);
      });

      it("returns a transport the shell did not create unchanged", () => {
        const foreign = { send: vi.fn(), onMessage: vi.fn() };
        expect(currentAuthTransport(foreign)).toBe(foreign);
      });
    });
  });

  describe("transport passthrough helpers", () => {
    it("forwards onClose to the underlying transport", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      let capturedWs: MockWebSocket;
      const originalWS = globalThis.WebSocket;
      (globalThis as any).WebSocket = class extends MockWebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols);
          capturedWs = this;
        }
      };

      try {
        const shell = new AuthShell();
        await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
        const transport = await shell.connect("ws://localhost:3000");
        const onClose = vi.fn();

        transport.onClose?.(onClose);
        capturedWs!._emit("close");

        expect(onClose).toHaveBeenCalled();
      } finally {
        (globalThis as any).WebSocket = originalWS;
      }
    });

    it("dispose() can be called on the returned transport", async () => {
      const mockClient = createMockAuth0Client({
        getTokenSilently: vi.fn().mockResolvedValue("token"),
      });
      createAuth0Client.mockResolvedValue(mockClient);

      const shell = new AuthShell();
      await shell.initialize({ domain: "d", clientId: "c", audience: "a" });
      const transport = await shell.connect("ws://localhost:3000");

      expect(() => transport.dispose?.()).not.toThrow();
    });
  });
});
