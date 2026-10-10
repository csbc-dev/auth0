/**
 * `<auth0-session>` against the REAL `@wc-bindable/remote` proxies (0.10+),
 * whose JsonValue gate validates every value that crosses the wire. The
 * sibling `authSession.test.ts` mocks `createRemoteCoreProxy` to control
 * sync timing, so it cannot observe the gate; here the session's proxy talks
 * to a real `RemoteShellProxy` over an in-memory loopback that JSON
 * round-trips each frame on a macrotask hop, the way a socket would.
 *
 * Pinned behaviors (documented in README-REMOTE.md / SPEC-REMOTE.md §3.7):
 *   - command forwarders pass their arguments to `proxy.invoke()` unchanged,
 *     so a non-JsonValue argument (a DOM Event, `undefined`) rejects with
 *     `WC_BINDABLE_INVALID_JSON_VALUE` before anything is sent — the failure
 *     behind the wcstack-state example's former `onclick: $command.<name>`;
 *   - a command returning a non-JsonValue rejects with
 *     `WC_BINDABLE_INVALID_RETURN_VALUE`;
 *   - when every declared property is a non-JsonValue at sync time the bind
 *     callback never fires, so `ready` stays false.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { WcBindableDeclaration } from "@wc-bindable/core";
import { RemoteShellProxy } from "@wc-bindable/remote";
import type {
  ClientMessage,
  ClientTransport,
  ServerMessage,
  ServerTransport,
} from "@wc-bindable/remote";

import { AuthSession } from "../src/components/AuthSession";
import { Auth } from "../src/components/Auth";
import { registerComponents } from "../src/registerComponents";

vi.mock("@auth0/auth0-spa-js", () => ({
  createAuth0Client: vi.fn(),
}));

registerComponents();

/** In-memory transport pair. Each frame is JSON round-tripped asynchronously. */
function createLoopback(): { client: ClientTransport; server: ServerTransport } {
  let toClient: ((msg: ServerMessage) => void) | null = null;
  let toServer: ((msg: ClientMessage) => void) | null = null;
  const deliver = (wire: string, target: () => ((msg: any) => void) | null): void => {
    setTimeout(() => target()?.(JSON.parse(wire)), 0);
  };
  return {
    client: {
      send: (msg) => deliver(JSON.stringify(msg), () => toServer),
      onMessage: (handler) => { toClient = handler; },
    },
    server: {
      send: (msg) => deliver(JSON.stringify(msg), () => toClient),
      onMessage: (handler) => { toServer = handler; },
    },
  };
}

const COUNTER_DECL: WcBindableDeclaration = {
  protocol: "wc-bindable",
  version: 1,
  properties: [{ name: "count", event: "json-gate:count-changed" }],
  commands: [{ name: "increment" }, { name: "stamp" }],
};

class CounterCore extends EventTarget {
  static wcBindable = COUNTER_DECL;
  count = 0;
  /** Argument lists of every `increment` call that reached the Core. */
  calls: unknown[][] = [];

  increment(...args: unknown[]): void {
    this.calls.push(args);
    this.count += 1;
    this.dispatchEvent(new CustomEvent("json-gate:count-changed", { detail: this.count }));
  }

  /** Returns a `Date`, which is not a JsonValue. */
  stamp(): Date {
    return new Date(0);
  }
}

let payloadTagSeq = 0;
function definePayloadTag(decl: WcBindableDeclaration): string {
  const tag = `json-gate-payload-${++payloadTagSeq}`;
  class PayloadEl extends HTMLElement {
    static wcBindable = decl;
  }
  customElements.define(tag, PayloadEl);
  return tag;
}

async function mountSession(
  core: EventTarget,
  decl: WcBindableDeclaration,
  shellLog: string[] = [],
): Promise<{ session: AuthSession; payload: any }> {
  const mod = await import("@auth0/auth0-spa-js");
  vi.mocked(mod.createAuth0Client).mockResolvedValue({
    isAuthenticated: vi.fn().mockResolvedValue(true),
    getUser: vi.fn().mockResolvedValue({ sub: "u" }),
    getTokenSilently: vi.fn().mockResolvedValue("jwt-token"),
    loginWithRedirect: vi.fn().mockResolvedValue(undefined),
    loginWithPopup: vi.fn().mockResolvedValue(undefined),
    logout: vi.fn().mockResolvedValue(undefined),
    handleRedirectCallback: vi.fn().mockResolvedValue(undefined),
  } as any);

  const authEl = document.createElement("auth0-gate") as Auth;
  authEl.id = "auth";
  authEl.setAttribute("domain", "d.auth0.com");
  authEl.setAttribute("client-id", "c");
  authEl.setAttribute("remote-url", "wss://example.com/ws");
  document.body.appendChild(authEl);
  await authEl.connectedCallbackPromise;

  // The "server" side of the connection: a real RemoteShellProxy wrapping
  // the Core, reachable through the loopback the stubbed connect() returns.
  const { client, server } = createLoopback();
  new RemoteShellProxy(core, server, {
    logger: { warn: (m) => shellLog.push(m), error: (m) => shellLog.push(m) },
  });
  vi.spyOn((authEl as any)._shell, "connect").mockResolvedValue(client);

  const session = document.createElement("auth0-session") as AuthSession;
  session.target = "auth";
  const payload = document.createElement(definePayloadTag(decl));
  session.appendChild(payload);
  document.body.appendChild(session);
  await session.connectedCallbackPromise;
  return { session, payload };
}

describe("<auth0-session> with the real @wc-bindable/remote JsonValue gate", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The session builds its proxy with the default console logger.
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = "";
  });

  it("forwarders pass arguments through: a DOM Event or an explicit undefined rejects with WC_BINDABLE_INVALID_JSON_VALUE before sending", async () => {
    const core = new CounterCore();
    const { session, payload } = await mountSession(core, COUNTER_DECL);
    await vi.waitFor(() => expect(session.ready).toBe(true));
    expect(payload.count).toBe(0);

    // What a DOM-event-driven command emit (`onclick: $command.increment`)
    // hands the forwarder.
    await expect(payload.increment(new MouseEvent("click")))
      .rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_JSON_VALUE" });
    // `undefined` is no longer coerced to `null` on the way out either.
    await expect(payload.increment(undefined))
      .rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_JSON_VALUE" });
    expect(core.calls).toEqual([]);

    // A call with no payload reaches the Core, and the new count syncs back
    // onto the payload mirror; the rejected calls left the session healthy.
    await expect(payload.increment()).resolves.toBeUndefined();
    expect(core.calls).toEqual([[]]);
    await vi.waitFor(() => expect(payload.count).toBe(1));
    expect(session.ready).toBe(true);
    expect(session.error).toBeNull();
  });

  it("a command returning a non-JsonValue rejects with WC_BINDABLE_INVALID_RETURN_VALUE", async () => {
    const { session, payload } = await mountSession(new CounterCore(), COUNTER_DECL);
    await vi.waitFor(() => expect(session.ready).toBe(true));

    await expect(payload.stamp())
      .rejects.toMatchObject({ code: "WC_BINDABLE_INVALID_RETURN_VALUE" });
  });

  it("ready stays false when every declared property is a non-JsonValue at sync", async () => {
    const DATE_DECL: WcBindableDeclaration = {
      protocol: "wc-bindable",
      version: 1,
      properties: [{ name: "updatedAt", event: "json-gate:updated-at-changed" }],
    };
    class DateCore extends EventTarget {
      static wcBindable = DATE_DECL;
      get updatedAt(): Date {
        return new Date(0);
      }
    }
    const shellLog: string[] = [];
    const { session } = await mountSession(new DateCore(), DATE_DECL, shellLog);

    // The producer drops the value and lists it under `getterFailures`; the
    // consumer keeps "no value" and dispatches nothing, so the session's
    // first-batch detection never runs.
    await vi.waitFor(() => {
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('could not read or transmit property "updatedAt"'),
      );
    });
    expect(shellLog.some((m) => m.includes('dropped sync value for "updatedAt"'))).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(session.ready).toBe(false);
    expect(session.error).toBeNull();
    expect(session.proxy).not.toBeNull();
  });
});
