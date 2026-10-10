import type { IWcBindable } from "./types.js";

/**
 * Freeze a `static wcBindable` declaration in place: the object, its
 * `properties` / `inputs` / `commands` lists and every entry.
 *
 * A declaration is one object shared by every reader of
 * `target.constructor.wcBindable` (binding adapters,
 * `createRemoteCoreProxy()`, `registerCoreDeclaration()`,
 * `<auth0-session>`), and `Auth.wcBindable` reuses
 * `AuthShell.wcBindable`'s property entries. A write to any part of it
 * would leak into all of them.
 *
 * `IWcBindable` cannot express this as `readonly` lists: it must stay
 * assignable to `@wc-bindable/core`'s `WcBindableDeclaration`, whose
 * lists are mutable arrays (see `IWcBindable` in types.ts). The freeze
 * is what keeps the declaration immutable.
 */
export function freezeWcBindable(declaration: IWcBindable): IWcBindable {
  for (const list of [declaration.properties, declaration.inputs, declaration.commands]) {
    if (list) {
      for (const entry of list) Object.freeze(entry);
      Object.freeze(list);
    }
  }
  return Object.freeze(declaration);
}
