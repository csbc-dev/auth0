import type { ReactNode } from "react";
import { useWcBindable } from "@wc-bindable/react";
import type { Auth, AuthSession, AuthValues } from "@csbc-dev/auth0";

interface SessionValues {
  ready: boolean;
  connecting: boolean;
  error: Error | null;
}

// Properties + commands declared on AppCoreFacade (server-mirrored).
interface FacadeValues {
  count: number;
  lastUpdatedBy: string;
}
interface FacadeElement extends HTMLElement, FacadeValues {
  // Command forwarders installed by <auth0-session> at connect time.
  // Marked optional because they do NOT exist on the element before the
  // session connects (own-property assignments happen inside
  // AuthSession._installPayloadCommandForwarders). Once
  // `sessionValues.ready === true` they are guaranteed to be present —
  // AuthSession installs forwarders synchronously BEFORE registering
  // `bind()`, and `ready` only flips after `bind()` has dispatched its
  // first batch (see src/components/AuthSession.ts:594-651). The
  // `ready && ...` render guard below is therefore the contract that
  // makes the `.increment?.()` call safe.
  increment?: (...args: unknown[]) => Promise<unknown>;
  decrement?: (...args: unknown[]) => Promise<unknown>;
  reset?: (...args: unknown[]) => Promise<unknown>;
}

function errorText(err: unknown): string {
  if (!err) return "";
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err !== null && "error" in err) {
    return String((err as { error: string }).error);
  }
  return String(err);
}

const env = import.meta.env;

export default function App() {
  const [authRef, authValues] = useWcBindable<Auth, AuthValues>();
  const [sessionRef, sessionValues] = useWcBindable<AuthSession, SessionValues>();
  // Bind directly on the payload child — the session mirrors property
  // updates onto it as own data properties + the user-declared events,
  // so `useWcBindable` against the facade sees the live Core surface
  // with no manual proxy bridging. The same ref is what we call command
  // forwarders through in the click handlers below; no second ref needed.
  const [facadeRef, facadeValues] = useWcBindable<FacadeElement, FacadeValues>();

  const status =
    authValues.loading           ? "Loading Auth0…" :
    !authValues.authenticated    ? "Signed out." :
    sessionValues.ready          ? "Session ready." :
    sessionValues.connecting     ? "Opening session…" :
                                   "Authenticated, waiting for session…";

  return (
    <main style={{ font: "14px/1.5 system-ui, sans-serif", maxWidth: 480, margin: "2rem auto", padding: "0 1rem" }}>
      <h1>React — remote mode</h1>

      <auth0-gate
        ref={authRef}
        id="auth"
        domain={env.VITE_AUTH0_DOMAIN}
        client-id={env.VITE_AUTH0_CLIENT_ID}
        audience={env.VITE_AUTH0_AUDIENCE}
        remote-url={env.VITE_REMOTE_URL ?? "ws://localhost:3000"}
        redirect-uri={window.location.origin}
      />
      <auth0-session ref={sessionRef} target="auth">
        <app-core-facade ref={facadeRef} />
      </auth0-session>

      <Section>
        <p style={{ color: "#666" }}>{status}</p>
        {authValues.error && <p style={{ color: "#b00" }}>Auth error: {errorText(authValues.error)}</p>}
        {sessionValues.error && <p style={{ color: "#b00" }}>Session error: {errorText(sessionValues.error)}</p>}

        {!authValues.loading && !authValues.authenticated && (
          <button onClick={() => authRef.current?.login()}>Sign in</button>
        )}
        {authValues.authenticated && (
          <button onClick={() => authRef.current?.logout({ logoutParams: { returnTo: window.location.origin } })}>
            Sign out
          </button>
        )}
      </Section>

      {sessionValues.ready && (
        <Section>
          <p>Count: <strong>{facadeValues.count ?? 0}</strong></p>
          <p style={{ color: "#666" }}>Last updated by: {facadeValues.lastUpdatedBy ?? ""}</p>
          <Row>
            <button onClick={() => facadeRef.current?.increment?.()}>+1</button>
            <button onClick={() => facadeRef.current?.decrement?.()}>−1</button>
            <button onClick={() => facadeRef.current?.reset?.()}>Reset</button>
          </Row>
        </Section>
      )}
    </main>
  );
}

function Section({ children }: { children: ReactNode }) {
  return <section style={{ margin: "1rem 0", padding: "1rem", border: "1px solid #ddd", borderRadius: 6 }}>{children}</section>;
}
function Row({ children }: { children: ReactNode }) {
  return <div style={{ display: "flex", gap: "0.5rem" }}>{children}</div>;
}
