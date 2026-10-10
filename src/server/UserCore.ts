import type { IWcBindable, UserContext } from "../types.js";
import { freezeWcBindable } from "../freezeWcBindable.js";

/**
 * Reference implementation: a server-side Core that exposes
 * authenticated user information as wc-bindable properties.
 *
 * Instantiate with the `UserContext` returned by `verifyAuth0Token()`.
 *
 * Event naming: the `auth0-gate-user:` prefix separates UserCore's
 * server-side bindable events from AuthCore's client-side events
 * (`auth0-gate:`). Both cores publish a `user-changed` event but with
 * different payload shapes — AuthCore dispatches `AuthUser | null`
 * (the Auth0 ID token profile, including Auth0-specific fields like
 * `picture`, `sid`, `updated_at`), while UserCore dispatches a
 * server-side `{ sub, email?, name? }` projection of `UserContext`
 * (absent claims omitted — see `currentUser`).
 *
 * Without the namespace, a pass-through / bridge that forwarded the
 * raw event name across the CSBC wire would silently overlap on the
 * client, delivering UserCore's restricted projection into consumers
 * that expected the full AuthCore profile (or vice versa). The
 * separate prefix keeps the two surfaces independently addressable
 * and lets consumers choose precisely which core they subscribe to.
 *
 * Separate `permissions-changed` / `roles-changed` events are also
 * namespaced for symmetry even though AuthCore does not emit those —
 * future AuthCore additions of RBAC state would otherwise collide.
 */
export class UserCore extends EventTarget {
  static wcBindable: IWcBindable = freezeWcBindable({
    protocol: "wc-bindable",
    version: 1,
    properties: [
      { name: "currentUser", event: "auth0-gate-user:user-changed" },
      { name: "permissions", event: "auth0-gate-user:permissions-changed" },
      { name: "roles",       event: "auth0-gate-user:roles-changed" },
    ],
  });

  private _user: UserContext;

  constructor(user: UserContext) {
    super();
    this._user = user;
  }

  /**
   * Absent claims are OMITTED from the projection, never present as
   * `undefined`. Auth0 access tokens carry no `email` / `name` claim by
   * default, so `verifyAuth0Token()` routinely yields a `UserContext`
   * with both fields `undefined`. `@wc-bindable/remote` (>= 0.10)
   * validates every outbound property value as a strict `JsonValue`,
   * and an object field whose value is `undefined` rejects the WHOLE
   * value rather than being dropped the way `JSON.stringify` drops it:
   * the `sync` snapshot would list `currentUser` under `getterFailures`
   * and every `user-changed` update would be discarded with a warning,
   * so the client would never receive the user at all. Omitting the
   * keys keeps the declared `{ sub; email?; name? }` shape and delivers
   * exactly what older `remote` versions delivered after
   * `JSON.stringify` silently dropped the `undefined` fields.
   */
  get currentUser(): { sub: string; email?: string; name?: string } {
    const user: { sub: string; email?: string; name?: string } = { sub: this._user.sub };
    if (this._user.email !== undefined) user.email = this._user.email;
    if (this._user.name !== undefined) user.name = this._user.name;
    return user;
  }

  get permissions(): string[] {
    return [...this._user.permissions];
  }

  get roles(): string[] {
    return [...this._user.roles];
  }

  /**
   * Replace the backing UserContext (e.g. after an in-band token refresh)
   * and dispatch wc-bindable change events for any field whose value
   * differs from the previous context.
   */
  updateUser(user: UserContext): void {
    const prev = this._user;
    this._user = user;

    if (
      prev.sub !== user.sub ||
      prev.email !== user.email ||
      prev.name !== user.name
    ) {
      this.dispatchEvent(new CustomEvent("auth0-gate-user:user-changed", {
        detail: this.currentUser,
        bubbles: true,
      }));
    }
    if (!_sameStringArray(prev.permissions, user.permissions)) {
      this.dispatchEvent(new CustomEvent("auth0-gate-user:permissions-changed", {
        detail: this.permissions,
        bubbles: true,
      }));
    }
    if (!_sameStringArray(prev.roles, user.roles)) {
      this.dispatchEvent(new CustomEvent("auth0-gate-user:roles-changed", {
        detail: this.roles,
        bubbles: true,
      }));
    }
  }
}

/**
 * Multiset equality on string arrays. Auth0 RBAC claims (`permissions`
 * / `roles`) are unordered sets by contract — a refresh that changes
 * ONLY the emit order (e.g. `["read","write"]` → `["write","read"]`)
 * must not fire a spurious change event, otherwise downstream
 * bindings re-render on noise. We compare by sorted copies so equal
 * multisets compare equal regardless of duplicates or order.
 */
function _sameStringArray(a: string[], b: string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  for (let i = 0; i < sortedA.length; i++) {
    if (sortedA[i] !== sortedB[i]) return false;
  }
  return true;
}
