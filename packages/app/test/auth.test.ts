import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { openDb, type Db } from "@kwazat/db";

// Emails of these tests go to a temporary mailbox.
process.env.KWAZAT_MAIL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kwazat-mail-"));

const { access, safeNextPath } = await import("../src/lib/access.ts");
const { createAuth } = await import("../src/lib/auth.ts");
const { readDevMailbox } = await import("../src/lib/mail.ts");
const { resetTwoFactor, setUser, useEmailCodes } = await import("../src/lib/users.ts");
const { TEST_ACCOUNT } = await import("./test-account.ts");

const withTwoFactor = { twoFactorEnabled: true };

test("phase 1: every path needs a session except login, the auth API and the dev mailbox", () => {
  for (const p of ["/", "/search", "/entity/x", "/account", "/red-lines", "/anything"]) assert.equal(access(p, null), "login", p);
  for (const p of ["/login", "/login/code", "/api/auth/sign-in/email"]) assert.equal(access(p, null), "allow", p);
  assert.equal(access("/loginx", null), "login");
  assert.equal(access("/dev/mail", null, { development: true }), "allow");
  assert.equal(access("/dev/mail", null, { development: false }), "login");
  for (const p of ["/", "/search", "/account"]) assert.equal(access(p, withTwoFactor), "allow", p);
});

test("phase 2: browsing and search open, account and red lines still private", () => {
  const opts = { loginEverywhere: false };
  for (const p of ["/", "/search", "/entity/x"]) assert.equal(access(p, null, opts), "allow", p);
  for (const p of ["/account", "/account/two-factor", "/red-lines"]) assert.equal(access(p, null, opts), "login", p);
});

test("a session without a second factor can only set one up", () => {
  const viewer = { twoFactorEnabled: false };
  for (const p of ["/", "/search", "/account", "/red-lines"]) assert.equal(access(p, viewer), "enroll", p);
  assert.equal(access("/account/two-factor", viewer), "allow");
  assert.equal(access("/login", viewer), "allow");
  assert.equal(access("/", viewer, { loginEverywhere: false }), "enroll");
});

test("safeNextPath only returns paths on this site", () => {
  assert.equal(safeNextPath("/search?q=a"), "/search?q=a");
  for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", "javascript:alert(1)", "/login", "/api/auth/x", "/dev/mail", undefined, 3]) {
    assert.equal(safeNextPath(bad), "/", String(bad));
  }
});

describe("auth", () => {
  let db: Db;
  let auth: ReturnType<typeof createAuth>;
  const base = "http://localhost:3000/api/auth";
  const post = (p: string, body: unknown, cookie = "") =>
    auth.handler(
      new Request(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie },
        body: JSON.stringify(body),
      }),
    );
  const cookiesOf = (res: Response) =>
    res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

  before(async () => {
    db = await openDb({ dataDir: "memory://" });
    auth = createAuth(db);
    await setUser(db, TEST_ACCOUNT.email, TEST_ACCOUNT.password, "create");
  });
  after(() => db.close());

  test("there is no signup", async () => {
    const res = await post("/sign-up/email", { email: "new@example.com", password: "a-long-enough-password", name: "New" });
    assert.ok(res.status >= 400, `status ${res.status}`);
    assert.equal(await (await auth.$context).internalAdapter.findUserByEmail("new@example.com"), null);
    await assert.rejects(auth.api.signUpEmail({ body: { email: "new@example.com", password: "a-long-enough-password", name: "New" } }));
  });

  test("without a second factor, login opens a session the gate sends to enrollment", async () => {
    const ok = await post("/sign-in/email", { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password });
    assert.equal(ok.status, 200);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesOf(ok) }) });
    assert.equal(session?.user.email, TEST_ACCOUNT.email);
    assert.equal(access("/", session!.user), "enroll");

    const bad = await post("/sign-in/email", { email: TEST_ACCOUNT.email, password: "wrong-password-123" });
    assert.equal(bad.status, 401);
  });

  test("with codes by email, the password alone opens no session", async () => {
    await useEmailCodes(db, TEST_ACCOUNT.email);
    const step1 = await post("/sign-in/email", { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password });
    assert.equal((await step1.json()).twoFactorRedirect, true);
    const pending = cookiesOf(step1);
    assert.equal(await auth.api.getSession({ headers: new Headers({ cookie: pending }) }), null);

    assert.equal((await post("/two-factor/send-otp", {}, pending)).status, 200);
    const mail = readDevMailbox(1)[0]!;
    assert.equal(mail.to, TEST_ACCOUNT.email);
    const code = mail.subject.match(/^(\d{6}) /)![1]!;
    assert.match(mail.text, new RegExp(`/login/code\\?code=${code}`));

    assert.equal((await post("/two-factor/verify-otp", { code: "000000" }, pending)).status, 401);
    const step2 = await post("/two-factor/verify-otp", { code }, pending);
    assert.equal(step2.status, 200);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesOf(step2) }) });
    assert.equal(session?.user.twoFactorEnabled, true);
    assert.equal(access("/", session!.user), "allow");
  });

  test("a new password or a second factor reset logs out every session", async () => {
    const sessions = async () => (await (await auth.$context).internalAdapter.listSessions((await (await auth.$context).internalAdapter.findUserByEmail(TEST_ACCOUNT.email))!.user.id)).length;
    assert.ok((await sessions()) > 0);
    assert.equal(await setUser(db, TEST_ACCOUNT.email, "another-long-password", "reset"), "updated");
    assert.equal(await sessions(), 0);
    await resetTwoFactor(db, TEST_ACCOUNT.email);
    const user = await (await auth.$context).internalAdapter.findUserByEmail(TEST_ACCOUNT.email);
    assert.equal((user!.user as { twoFactorEnabled?: boolean }).twoFactorEnabled, false);
  });
});
