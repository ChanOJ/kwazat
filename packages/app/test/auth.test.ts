import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { openDb, type Db } from "@kwazat/db";
import { needsLogin, safeNextPath } from "../src/lib/access.ts";
import { createAuth, type Auth } from "../src/lib/auth.ts";
import { setUser } from "../src/lib/users.ts";
import { TEST_ACCOUNT } from "./test-account.ts";

test("phase 1: every path needs a session except the login page and the auth API", () => {
  for (const path of ["/", "/search", "/search?q=x", "/settings", "/anything/else"]) assert.equal(needsLogin(path), true, path);
  for (const path of ["/login", "/api/auth/sign-in/email", "/api/auth/get-session"]) assert.equal(needsLogin(path), false, path);
  assert.equal(needsLogin("/loginx"), true);
});

test("phase 2: browsing and search open, settings and account still private", () => {
  for (const path of ["/", "/search"]) assert.equal(needsLogin(path, false), false, path);
  for (const path of ["/settings", "/settings/red-lines", "/account"]) assert.equal(needsLogin(path, false), true, path);
});

test("safeNextPath only returns paths on this site", () => {
  assert.equal(safeNextPath("/search?q=a"), "/search?q=a");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/login", "/api/auth/x", undefined, 3]) {
    assert.equal(safeNextPath(bad), "/", String(bad));
  }
});

describe("auth", () => {
  let db: Db;
  let auth: Auth;
  const base = "http://localhost:3000/api/auth";
  const post = (path: string, body: unknown) =>
    auth.handler(new Request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:3000" }, body: JSON.stringify(body) }));

  before(async () => {
    db = await openDb({ dataDir: "memory://" });
    auth = createAuth(db);
    await setUser(db, TEST_ACCOUNT.email, TEST_ACCOUNT.name, TEST_ACCOUNT.password, "create");
  });
  after(() => db.close());

  test("there is no signup", async () => {
    const res = await post("/sign-up/email", { email: "new@example.com", password: "a-long-enough-password", name: "New" });
    assert.ok(res.status >= 400, `status ${res.status}`);
    assert.equal(await (await auth.$context).internalAdapter.findUserByEmail("new@example.com"), null);
    await assert.rejects(auth.api.signUpEmail({ body: { email: "new@example.com", password: "a-long-enough-password", name: "New" } }));
  });

  test("an account made with setUser can log in, a wrong password cannot", async () => {
    const ok = await post("/sign-in/email", { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password });
    assert.equal(ok.status, 200);
    const cookie = ok.headers.get("set-cookie") ?? "";
    assert.match(cookie, /session_token=/);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookie.split(";")[0]! }) });
    assert.equal(session?.user.email, TEST_ACCOUNT.email);

    const bad = await post("/sign-in/email", { email: TEST_ACCOUNT.email, password: "wrong-password-123" });
    assert.equal(bad.status, 401);
  });

  test("a new password logs out every session", async () => {
    const ok = await post("/sign-in/email", { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password });
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
    assert.equal(await setUser(db, TEST_ACCOUNT.email, TEST_ACCOUNT.name, "another-long-password", "reset"), "updated");
    assert.equal(await auth.api.getSession({ headers: new Headers({ cookie }) }), null);
  });
});
