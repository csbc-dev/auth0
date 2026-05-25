// Integration tests for the example server's static `/_shared/` mount and the
// CORS path it shares with `/auth-config`.
//
// These spawn the REAL server.js as a subprocess (so the tests exercise the
// shipped file, not a copy that could drift) with dummy Auth0 env — none of the
// asserted routes do Auth0 network I/O, so the dummy values are never verified.
// Node built-ins only (`node:test`): no test-framework dependency to install.
//
// Run:  npm test   (from examples/server, after `npm install` here)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ALLOWED = "http://localhost:5176";
const DISALLOWED = "http://evil.example";

let child;
let port;
let childStderr = "";

// Grab a free port by binding :0, reading the assigned port, then releasing it.
// A tiny TOCTOU window remains before the child re-binds it; acceptable for a
// local example test (a collision surfaces as a startup timeout below).
function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port: p } = srv.address();
      srv.close(() => resolve(p));
    });
  });
}

function httpGet(path, { origin } = {}) {
  return new Promise((resolve, reject) => {
    const headers = origin ? { Origin: origin } : {};
    // `path` is sent verbatim — Node's http client does NOT percent-decode or
    // normalize `..`, so the encoded-traversal cases below reach the server
    // exactly as written.
    const req = http.request(
      { host: "127.0.0.1", port, path, method: "GET", headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function waitForReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await httpGet("/auth-config", { origin: ALLOWED });
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
}

before(async () => {
  port = await getFreePort();
  child = spawn(process.execPath, ["server.js"], {
    cwd: HERE,
    env: {
      ...process.env,
      AUTH0_DOMAIN: "dummy.auth0.com",
      AUTH0_CLIENT_ID: "dummyclient",
      AUTH0_AUDIENCE: "https://dummy/api",
      PORT: String(port),
      ALLOWED_ORIGINS: ALLOWED,
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d) => (childStderr += d));
  try {
    await waitForReady();
  } catch (err) {
    child.kill();
    throw new Error(
      `example server did not start on :${port} ` +
        "(did you run `npm install` in examples/server?)\n--- server stderr ---\n" +
        childStderr,
    );
  }
});

after(() => {
  child?.kill();
});

test("GET /_shared/appCoreFacade.auto.js serves the module with allowed-origin CORS", async () => {
  const res = await httpGet("/_shared/appCoreFacade.auto.js", { origin: ALLOWED });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /application\/javascript/);
  assert.equal(res.headers["access-control-allow-origin"], ALLOWED);
  assert.match(res.headers["vary"] ?? "", /Origin/);
  // The module's side effect — proves the real file (not a stub) was served.
  assert.match(res.body, /defineAppCoreFacade\(\)/);
});

test("the relative-imported chain (appCoreFacade.js, appCore.js) is also reachable", async () => {
  for (const path of ["/_shared/appCoreFacade.js", "/_shared/appCore.js"]) {
    const res = await httpGet(path, { origin: ALLOWED });
    assert.equal(res.status, 200, `${path} should be 200`);
    assert.match(res.headers["content-type"], /application\/javascript/);
  }
});

test("static module carries no Access-Control-Allow-Origin for a disallowed origin", async () => {
  // The mount is intentionally not origin-gated (the schema is non-secret), so
  // the body is served — but the absent ACAO header is what stops a *browser*
  // on a disallowed origin from reading it cross-origin.
  const res = await httpGet("/_shared/appCoreFacade.auto.js", { origin: DISALLOWED });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], undefined);
});

test("path traversal via an encoded slash is rejected by the confine guard (403)", async () => {
  const res = await httpGet("/_shared/..%2fserver.js", { origin: ALLOWED });
  assert.equal(res.status, 403);
});

test("path traversal via encoded dot-segments is normalized away before routing (426)", async () => {
  // `%2e%2e` → `..` is collapsed by the WHATWG URL parser, so the path no
  // longer starts with /_shared/ and falls through to the 426 upgrade handler.
  const res = await httpGet("/_shared/%2e%2e/server.js", { origin: ALLOWED });
  assert.equal(res.status, 426);
});

test("a missing shared file returns 404", async () => {
  const res = await httpGet("/_shared/does-not-exist.js", { origin: ALLOWED });
  assert.equal(res.status, 404);
});

test("/auth-config (shared CORS path): allowed origin gets the config + ACAO", async () => {
  const res = await httpGet("/auth-config", { origin: ALLOWED });
  assert.equal(res.status, 200);
  assert.equal(res.headers["access-control-allow-origin"], ALLOWED);
  const cfg = JSON.parse(res.body);
  assert.equal(cfg.domain, "dummy.auth0.com");
  assert.equal(cfg.clientId, "dummyclient");
});

test("/auth-config (shared CORS path): disallowed origin is rejected (403)", async () => {
  const res = await httpGet("/auth-config", { origin: DISALLOWED });
  assert.equal(res.status, 403);
});
