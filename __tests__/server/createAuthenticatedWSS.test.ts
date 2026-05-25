import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(() => vi.fn()),
  jwtVerify: vi.fn(),
}));

class MockWebSocketServer {
  handlers: Record<string, (...args: any[]) => void> = {};
  handlerLists: Record<string, ((...args: any[]) => void)[]> = {};
  options: any;

  constructor(options: any) {
    this.options = options;
  }

  on(event: string, handler: (...args: any[]) => void): void {
    (this.handlerLists[event] ??= []).push(handler);
    this.handlers[event] = (...args: any[]) => {
      for (const listener of this.handlerLists[event] ?? []) {
        listener(...args);
      }
    };
  }
}

const wsServers: MockWebSocketServer[] = [];

vi.mock("ws", () => ({
  WebSocketServer: class {
    handlers: Record<string, (...args: any[]) => void> = {};
    handlerLists: Record<string, ((...args: any[]) => void)[]> = {};
    options: any;
    // Real `ws` exposes the live client set; the heartbeat loop iterates
    // it. Tests populate this directly to drive the interval callback.
    clients = new Set<any>();

    constructor(options: any) {
      this.options = options;
      wsServers.push(this as unknown as MockWebSocketServer);
    }

    on(event: string, handler: (...args: any[]) => void): void {
      (this.handlerLists[event] ??= []).push(handler);
      this.handlers[event] = (...args: any[]) => {
        for (const listener of this.handlerLists[event] ?? []) {
          listener(...args);
        }
      };
    }

    emit(event: string, ...args: any[]): void {
      this.handlers[event]?.(...args);
    }
  },
}));

import { _normalizeError, createAuthenticatedWSS } from "../../src/server/createAuthenticatedWSS";

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function createSocket() {
  const listeners: Record<string, ((...args: any[]) => void)[]> = {};
  return {
    send: vi.fn(),
    close: vi.fn(),
    on(type: string, listener: (...args: any[]) => void) {
      (listeners[type] ??= []).push(listener);
    },
    addEventListener(type: string, listener: (...args: any[]) => void) {
      (listeners[type] ??= []).push(listener);
    },
    _emit(type: string, ...args: any[]) {
      for (const fn of listeners[type] ?? []) fn(...args);
    },
  };
}

describe("createAuthenticatedWSS", () => {
  let jwtVerify: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    wsServers.length = 0;
    const jose = await import("jose");
    jwtVerify = jose.jwtVerify as ReturnType<typeof vi.fn>;
    jwtVerify.mockReset();
  });

  it("_normalizeError returns the original Error instance", () => {
    const err = new Error("boom");
    expect(_normalizeError(err)).toBe(err);
  });

  it("_normalizeError wraps non-Error throwables", () => {
    const err = _normalizeError("boom");
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("boom");
  });

  it("accepts only auth0-gate bearer protocol", async () => {
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      port: 3010,
    });

    const accepted = wss.options.handleProtocols(["foo", "auth0-gate.bearer.token"]);
    const rejected = wss.options.handleProtocols(["foo", "bar"]);

    expect(accepted).toBe("auth0-gate.bearer.token");
    expect(rejected).toBe(false);
  });

  it("rejects unauthorized tokens in verifyClient before upgrade", async () => {
    jwtVerify.mockRejectedValue(new Error("Invalid signature"));

    const events: Array<{ type: string; error?: Error }> = [];
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      onEvent: (event) => events.push(event),
    });

    const req = {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 300 }),
      },
    };

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        { origin: "https://allowed.example.com", secure: true, req },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 401, message: "Unauthorized" });
    expect(jwtVerify).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("auth:failure");
  });

  it("normalizes non-Error verifyClient verification failures", async () => {
    jwtVerify.mockRejectedValue("boom");

    const events: Array<{ type: string; error?: Error }> = [];
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      onEvent: (event) => events.push(event),
    });

    const req = {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({ sub: "auth0|123", exp: Math.floor(Date.now() / 1000) + 300 }),
      },
    };

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        { origin: "https://allowed.example.com", secure: true, req },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 401, message: "Unauthorized" });
    expect(events[0]?.type).toBe("auth:failure");
    expect(events[0]?.error).toBeInstanceOf(Error);
    expect(events[0]?.error?.message).toContain("boom");
  });

  it("rejects malformed protocol headers in verifyClient before upgrade", async () => {
    const events: Array<{ type: string; error?: Error }> = [];
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      onEvent: (event) => events.push(event),
    });

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        {
          origin: "https://allowed.example.com",
          secure: true,
          req: { headers: { origin: "https://allowed.example.com", "sec-websocket-protocol": "not-hawc-protocol" } },
        },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 401, message: "Unauthorized" });
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("auth:failure");
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("rejects non-string/non-array protocol headers in verifyClient with a structured error", async () => {
    // Regression guard for the runtime shape check in
    // `extractTokenFromProtocol`: a custom server that hands us a
    // `Buffer` / plain object (the declared type is
    // `string | string[] | undefined`, but TS is compile-time only and
    // other HTTP upgrade plumbing can still pass those) used to crash
    // inside `.split(",")` with a confusing native `TypeError`. Now it
    // is rejected with a clear Error that names the offending shape,
    // and `_normalizeError` still wraps any non-Error throw from the
    // extraction path into an Error instance before `onEvent` fires.
    const events: Array<{ type: string; error?: Error }> = [];
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      onEvent: (event) => events.push(event),
    });

    const protocolHeader = { foo: 1 };

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        {
          origin: "https://allowed.example.com",
          secure: true,
          req: { headers: { origin: "https://allowed.example.com", "sec-websocket-protocol": protocolHeader } },
        },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 401, message: "Unauthorized" });
    expect(events[0]?.type).toBe("auth:failure");
    expect(events[0]?.error).toBeInstanceOf(Error);
    expect(events[0]?.error?.message).toMatch(
      /Sec-WebSocket-Protocol header must be a string or string\[\]/,
    );
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("rejects missing origins in verifyClient before upgrade", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => new EventTarget(),
    });

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        {
          origin: "",
          secure: true,
          req: { headers: { "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }) } },
        },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: false, code: 403, message: "Forbidden origin" });
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it("reuses the verifyClient user on connection instead of re-verifying after upgrade", async () => {
    jwtVerify.mockResolvedValue({
      payload: {
        sub: "auth0|123",
        permissions: [],
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });

    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => core,
    });

    const req = {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({
          sub: "auth0|123",
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      },
    };

    const verdict = await new Promise<{ allowed: boolean; code?: number; message?: string }>((resolve) => {
      wss.options.verifyClient(
        { origin: "https://allowed.example.com", secure: true, req },
        (allowed: boolean, code?: number, message?: string) => resolve({ allowed, code, message }),
      );
    });

    expect(verdict).toEqual({ allowed: true, code: undefined, message: undefined });

    const socket = createSocket();
    await wss.handlers.connection(socket, req);

    expect(jwtVerify).toHaveBeenCalledTimes(1);
    expect(socket.close).not.toHaveBeenCalledWith(1008, "Unauthorized");
  });

  it("rejects disallowed origins", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => new EventTarget(),
    });

    const socket = createSocket();
    await wss.handlers.connection(socket, {
      headers: {
        origin: "https://blocked.example.com",
        "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
      },
    });

    expect(socket.close).toHaveBeenCalledWith(1008, "Forbidden origin");
  });

  it("closes unauthorized connection when token extraction/verification fails", async () => {
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
    });

    const socket = createSocket();
    await wss.handlers.connection(socket, {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "not-hawc-protocol",
      },
    });

    expect(socket.close).toHaveBeenCalledWith(1008, "Unauthorized");
  });

  it("accepts connection for allowed origin and valid token", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });

    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => core,
    });

    const socket = createSocket();
    await wss.handlers.connection(socket, {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
      },
    });

    expect(socket.close).not.toHaveBeenCalledWith(1008, "Unauthorized");
    expect(socket.close).not.toHaveBeenCalledWith(1008, "Forbidden origin");
  });

  it("defaults WebSocketServer maxPayload to 256 KiB when unspecified", async () => {
    // Regression: the `ws` library defaults to 100 MiB which is far
    // larger than any legitimate `auth:refresh` (a JWT is a few KiB)
    // or normal RPC frame, so the server clamps the per-frame budget
    // to 256 KiB (262144) by default. A regression that drops this
    // floor would let a single client pin connection-worth memory by
    // streaming a single oversized frame.
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
    });

    expect(wss.options.maxPayload).toBe(256 * 1024);
  });

  it("forwards an explicit maxPayload to the WebSocketServer", async () => {
    // Applications that legitimately push larger frames (or want a
    // tighter limit than 256 KiB) override `maxPayload`. The value
    // must reach `new WebSocketServer({ maxPayload })` verbatim.
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      maxPayload: 8192,
    });

    expect(wss.options.maxPayload).toBe(8192);
  });

  it("propagates rolesClaim to the pre-handshake verifyClient verification path", async () => {
    // End-to-end: rolesClaim must reach the pre-handshake
    // verifyAuth0Token call inside verifyClient so that the
    // preVerifiedUser stashed for the connection handler already
    // carries the namespaced roles. A regression that drops
    // `rolesClaim` from this path would silently surface
    // `UserContext.roles === []` (or a legacy non-namespaced value)
    // for every connection going through the default factory,
    // even when the downstream handleConnection call site is wired
    // correctly.
    const NS = "https://api.example.com/roles";
    jwtVerify.mockResolvedValue({
      payload: {
        sub: "auth0|rc-verify",
        permissions: [],
        [NS]: ["editor", "admin"],
        roles: ["ignored-non-namespaced"],
        exp: Math.floor(Date.now() / 1000) + 300,
      },
    });

    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const createCores = vi.fn(() => core);

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      rolesClaim: NS,
      createCores,
    });

    const req = {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({
          sub: "auth0|rc-verify",
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      },
    };

    const verdict = await new Promise<{ allowed: boolean }>((resolve) => {
      wss.options.verifyClient(
        { origin: "https://allowed.example.com", secure: true, req },
        (allowed: boolean) => resolve({ allowed }),
      );
    });
    expect(verdict.allowed).toBe(true);

    const socket = createSocket();
    await wss.handlers.connection(socket, req);

    // Only ONE verifyAuth0Token call should have happened (verifyClient's);
    // the connection handler reuses the pre-verified user. That single
    // call must have materialised the namespaced roles, which is
    // observable through the user handed to `createCores`.
    expect(jwtVerify).toHaveBeenCalledTimes(1);
    expect(createCores).toHaveBeenCalledTimes(1);
    const passedUser = createCores.mock.calls[0][0];
    expect(passedUser.roles).toEqual(["editor", "admin"]);
  });

  // --- (1) server mode -----------------------------------------------------

  it("attaches to an existing http.Server in { server } mode (no port)", async () => {
    const fakeServer = { __id: "my-server" } as any;
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      server: fakeServer,
    });

    // ws is constructed with `server`, not `port`, and the pre-handshake
    // security hooks are still wired in this mode.
    expect(wss.options.server).toBe(fakeServer);
    expect(wss.options.port).toBeUndefined();
    expect(typeof wss.options.verifyClient).toBe("function");
    expect(typeof wss.options.handleProtocols).toBe("function");
  });

  it("throws when both server and port are provided", async () => {
    await expect(
      createAuthenticatedWSS({
        auth0Domain: "test.auth0.com",
        auth0Audience: "aud",
        createCores: () => new EventTarget(),
        server: {} as any,
        port: 3000,
      }),
    ).rejects.toThrow(/either `server` or `port`/);
  });

  // --- (2b) exposeAuthConfig sugar -----------------------------------------

  it("throws when exposeAuthConfig is combined with a caller-owned server", async () => {
    await expect(
      createAuthenticatedWSS({
        auth0Domain: "test.auth0.com",
        auth0Audience: "aud",
        createCores: () => new EventTarget(),
        server: {} as any,
        exposeAuthConfig: { clientId: "spa-123" },
      }),
    ).rejects.toThrow(/exposeAuthConfig.*only valid/s);
  });

  it("exposeAuthConfig: owns an http.Server that serves the config JSON and attaches ws via { server }", async () => {
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      port: 0, // ephemeral — avoids clashing with other tests
      exposeAuthConfig: { clientId: "spa-client-123" },
    });

    const server = wss.options.server as import("http").Server;
    expect(server).toBeDefined();
    expect(wss.options.port).toBeUndefined();

    // The factory's startListening() bound the ephemeral port. Wait for it.
    await new Promise<void>((resolve) => {
      if ((server as any).listening) resolve();
      else server.once("listening", () => resolve());
    });
    const addr = server.address() as import("net").AddressInfo;

    const { request } = await import("node:http");
    const result = await new Promise<{ status?: number; body: any }>((resolve, reject) => {
      const req = request(
        { host: "127.0.0.1", port: addr.port, path: "/auth-config", method: "GET" },
        (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () =>
            resolve({ status: res.statusCode, body: JSON.parse(data) }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      domain: "test.auth0.com",
      clientId: "spa-client-123",
      audience: "aud",
    });

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("exposeAuthConfig: closes the owned http.Server when wss closes", async () => {
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      port: 0,
      exposeAuthConfig: { clientId: "spa-client-123" },
    });

    const server = wss.options.server as import("http").Server;
    await new Promise<void>((resolve) => {
      if ((server as any).listening) resolve();
      else server.once("listening", () => resolve());
    });

    const closeSpy = vi.spyOn(server, "close");
    wss.handlers.close?.();

    expect(closeSpy).toHaveBeenCalledTimes(1);

    await new Promise<void>((resolve) => server.once("close", () => resolve()));
  });

  it("exposeAuthConfig: forwards owned http.Server errors to wss error listeners", async () => {
    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      createCores: () => new EventTarget(),
      port: 0,
      exposeAuthConfig: { clientId: "spa-client-123" },
    });

    const server = wss.options.server as import("http").Server;
    const onError = vi.fn();
    wss.on("error", onError);

    const boom = new Error("EADDRINUSE-ish");
    server.emit("error", boom);

    expect(onError).toHaveBeenCalledWith(boom);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("exposeAuthConfig + heartbeat: close dispatch runs both owned-server shutdown and heartbeat cleanup", async () => {
    vi.useFakeTimers();
    try {
      const wss: any = await createAuthenticatedWSS({
        auth0Domain: "test.auth0.com",
        auth0Audience: "aud",
        createCores: () => new EventTarget(),
        port: 0,
        heartbeatMs: 30_000,
        exposeAuthConfig: { clientId: "spa-client-123" },
      });

      const server = wss.options.server as import("http").Server;
      await new Promise<void>((resolve) => {
        if ((server as any).listening) resolve();
        else server.once("listening", () => resolve());
      });

      const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
      const closeSpy = vi.spyOn(server, "close");

      wss.emit("close");

      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(clearIntervalSpy).toHaveBeenCalled();

      await new Promise<void>((resolve) => server.once("close", () => resolve()));
    } finally {
      vi.useRealTimers();
    }
  });

  // --- (3) heartbeat (opt-in) ----------------------------------------------

  it("no heartbeat by default: no close handler, socket not marked", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => core,
    });

    // Heartbeat off → no `close` listener registered for clearInterval.
    expect(wss.handlers.close).toBeUndefined();

    const socket = createSocket();
    await wss.handlers.connection(socket, {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
      },
    });
    expect((socket as any).isAlive).toBeUndefined();
  });

  it("heartbeat: marks the socket alive on connect and wires pong", async () => {
    jwtVerify.mockResolvedValue({ payload: { sub: "auth0|123", permissions: [] } });
    const core = new EventTarget();
    (core.constructor as any).wcBindable = {
      protocol: "wc-bindable",
      version: 1,
      properties: [],
    };

    const wss: any = await createAuthenticatedWSS({
      auth0Domain: "test.auth0.com",
      auth0Audience: "aud",
      allowedOrigins: ["https://allowed.example.com"],
      createCores: () => core,
      port: 3011,
      heartbeatMs: 30_000,
    });

    const socket = createSocket();
    await wss.handlers.connection(socket, {
      headers: {
        origin: "https://allowed.example.com",
        "sec-websocket-protocol": "auth0-gate.bearer." + makeJwt({ sub: "auth0|123" }),
      },
    });

    expect((socket as any).isAlive).toBe(true);
    // pong handler resets the liveness flag.
    (socket as any).isAlive = false;
    socket._emit("pong");
    expect((socket as any).isAlive).toBe(true);

    // Release the interval registered by the heartbeat.
    wss.handlers.close?.();
  });

  it("heartbeat: pings live clients and terminates dead ones each tick", async () => {
    vi.useFakeTimers();
    try {
      const wss: any = await createAuthenticatedWSS({
        auth0Domain: "test.auth0.com",
        auth0Audience: "aud",
        createCores: () => new EventTarget(),
        port: 3012,
        heartbeatMs: 30_000,
      });

      const live = { isAlive: true, ping: vi.fn(), terminate: vi.fn() };
      const dead = { isAlive: false, ping: vi.fn(), terminate: vi.fn() };
      wss.clients.add(live);
      wss.clients.add(dead);

      vi.advanceTimersByTime(30_000);

      // Dead client (never ponged since last tick) is terminated, not pinged.
      expect(dead.terminate).toHaveBeenCalledTimes(1);
      expect(dead.ping).not.toHaveBeenCalled();
      // Live client is flipped to "awaiting pong" and pinged.
      expect(live.terminate).not.toHaveBeenCalled();
      expect(live.ping).toHaveBeenCalledTimes(1);
      expect(live.isAlive).toBe(false);

      wss.handlers.close?.();
    } finally {
      vi.useRealTimers();
    }
  });
});
