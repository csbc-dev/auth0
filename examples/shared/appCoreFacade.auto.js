// Side-effect entry: registers <app-core-facade> on load — no exports, no call
// needed by the consumer. Mirrors the CDN `/auto` convention used by the
// @csbc-dev/* components (and feature-flags' shared <demo-session>/auto.js).
//
// The buildless wcstack-state example loads this over the example server's
// `/_shared/` static mount:
//
//   <script type="module" src="http://localhost:3000/_shared/appCoreFacade.auto.js"></script>
//
// Why server-delivered instead of a class defined inline in the page: the
// schema then flows from the SINGLE source of truth — `appCoreDeclaration` in
// ./appCore.js, the same declaration the server-side `AppCore` carries — via
// ./appCoreFacade.js. There is no hand-written duplicate in the HTML to keep in
// sync. (appCore.js has no bare imports, so no page-side import map is needed.)
//
// Timing is safe even though this loads asynchronously and cross-origin:
// <auth0-session> adopts the first wc-bindable child via
// `child.constructor.wcBindable` and, when the child is not yet upgraded, awaits
// `customElements.whenDefined("app-core-facade")` before adopting it. So the
// load order between this script and the auto bundles does not matter.
import { defineAppCoreFacade } from "./appCoreFacade.js";

defineAppCoreFacade();
