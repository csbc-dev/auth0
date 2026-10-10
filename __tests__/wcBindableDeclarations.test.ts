import { describe, it, expect, expectTypeOf } from "vitest";
import { getWcBindableDeclaration, type WcBindableDeclaration } from "@wc-bindable/core";
import { createRemoteCoreProxy, type ClientTransport } from "@wc-bindable/remote";
import {
  AuthCore,
  AuthShell,
  Auth,
  AuthConfig,
  AuthSession,
  registerCoreDeclaration,
  getCoreDeclaration,
  unregisterCoreDeclaration,
} from "../src/index";
import { UserCore } from "../src/server/index";
import { freezeWcBindable } from "../src/freezeWcBindable";
import type { IWcBindable } from "../src/types";

/**
 * Every `static wcBindable` this package publishes must be usable as-is
 * wherever `@wc-bindable/*` asks for a `WcBindableDeclaration`, and must
 * stay immutable.
 *
 * The "no cast" half is a compile-time guarantee: vitest strips types, so
 * it is enforced by `npm run typecheck` (tsconfig.test.json includes this
 * file). If `IWcBindable` goes back to `readonly` lists, the uncast calls
 * below stop compiling.
 */

const DECLARATIONS: ReadonlyArray<[string, IWcBindable]> = [
  ["UserCore", UserCore.wcBindable],
  ["AuthCore", AuthCore.wcBindable],
  ["AuthShell", AuthShell.wcBindable],
  ["Auth", Auth.wcBindable],
  ["AuthConfig", AuthConfig.wcBindable],
  ["AuthSession", AuthSession.wcBindable],
];

function silentTransport(): ClientTransport {
  return { send: () => {}, onMessage: () => {} };
}

describe("wcBindable declarations: assignable to WcBindableDeclaration", () => {
  it("IWcBindable extends WcBindableDeclaration", () => {
    expectTypeOf<IWcBindable>().toExtend<WcBindableDeclaration>();
  });

  it("every published declaration is a WcBindableDeclaration", () => {
    const declarations: WcBindableDeclaration[] = [
      UserCore.wcBindable,
      AuthCore.wcBindable,
      AuthShell.wcBindable,
      Auth.wcBindable,
      AuthConfig.wcBindable,
      AuthSession.wcBindable,
    ];
    expect(declarations).toHaveLength(DECLARATIONS.length);
  });

  it("createRemoteCoreProxy(UserCore.wcBindable, transport) needs no cast", () => {
    const proxy = createRemoteCoreProxy(UserCore.wcBindable, silentTransport());
    try {
      expect(getWcBindableDeclaration(proxy)?.properties.map((p) => p.name))
        .toEqual(["currentUser", "permissions", "roles"]);
    } finally {
      proxy.dispose();
    }
  });

  it("registerCoreDeclaration(key, UserCore.wcBindable) needs no cast", () => {
    const key = "wcBindableDeclarations.test:user-core";
    registerCoreDeclaration(key, UserCore.wcBindable);
    try {
      expect(getCoreDeclaration(key)).toBe(UserCore.wcBindable);
    } finally {
      unregisterCoreDeclaration(key);
    }
  });
});

describe("wcBindable declarations: immutable at runtime", () => {
  it.each(DECLARATIONS)("%s.wcBindable is frozen, including its lists and entries", (_name, decl) => {
    expect(Object.isFrozen(decl)).toBe(true);
    for (const list of [decl.properties, decl.inputs, decl.commands]) {
      if (!list) continue;
      expect(Object.isFrozen(list)).toBe(true);
      for (const entry of list) expect(Object.isFrozen(entry)).toBe(true);
    }
  });

  it("a push onto a shared list throws and leaves the declaration unchanged", () => {
    expect(() => UserCore.wcBindable.properties.push({ name: "x", event: "x:changed" }))
      .toThrow(TypeError);
    expect(UserCore.wcBindable.properties).toHaveLength(3);
  });

  it("an entry Auth.wcBindable reuses from AuthShell.wcBindable cannot be rewritten", () => {
    const shared = AuthShell.wcBindable.properties[0];
    expect(Auth.wcBindable.properties[0]).toBe(shared);
    expect(() => { (shared as { event: string }).event = "hijacked"; }).toThrow(TypeError);
    expect(Auth.wcBindable.properties[0].event).toBe("auth0-gate:authenticated-changed");
  });

  it("top-level fields stay readonly in the type and frozen at runtime", () => {
    expect(() => {
      // @ts-expect-error -- `IWcBindable` keeps its top-level fields `readonly`.
      UserCore.wcBindable.version = 2;
    }).toThrow(TypeError);
    expect(UserCore.wcBindable.version).toBe(1);
  });
});

describe("freezeWcBindable", () => {
  it("freezes in place and returns the same object typed as IWcBindable", () => {
    const decl = {
      protocol: "wc-bindable" as const,
      version: 1,
      properties: [{ name: "a", event: "a:changed" }],
      inputs: [{ name: "b" }],
      commands: [{ name: "c", async: true }],
    };
    const frozen = freezeWcBindable(decl);
    expectTypeOf(frozen).toEqualTypeOf<IWcBindable>();
    expect(frozen).toBe(decl);
    expect(Object.isFrozen(decl)).toBe(true);
    expect(Object.isFrozen(decl.properties[0])).toBe(true);
    expect(Object.isFrozen(decl.inputs)).toBe(true);
    expect(Object.isFrozen(decl.commands[0])).toBe(true);
  });
});
