import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { openDb, sql, type Db } from "@kwazat/db";

// Emails of these tests go to a temporary mailbox.
process.env.KWAZAT_MAIL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "kwazat-mail-"));

const { isDevKey, hasDevCookie, devKey, devGateEnabled } = await import("../src/lib/dev-gate.ts");
const { passwordIssues } = await import("../src/lib/password.ts");
const { access, safeNextPath } = await import("../src/lib/access.ts");
const { createAuth } = await import("../src/lib/auth.ts");
const { readDevMailbox } = await import("../src/lib/mail.ts");
const { createAccount, CliError, resetTwoFactor, setUser, useEmailCodes } = await import("../src/lib/users.ts");
const { TEST_ACCOUNT } = await import("./test-account.ts");

const withTwoFactor = { twoFactorEnabled: true };

test("login everywhere: every path needs a session except login, the auth API and the dev mailbox", () => {
  const all = { loginEverywhere: true };
  for (const p of ["/", "/search", "/entity/x", "/settings", "/red-lines", "/anything"]) assert.equal(access(p, null, all), "login", p);
  for (const p of ["/login", "/login/code", "/api/auth/sign-in/email"]) assert.equal(access(p, null, all), "allow", p);
  assert.equal(access("/loginx", null, all), "login");
  assert.equal(access("/dev/mail", null, { ...all, development: true }), "allow");
  assert.equal(access("/dev/mail", null, { ...all, development: false }), "login");
  for (const p of ["/", "/search", "/settings"]) assert.equal(access(p, withTwoFactor, all), "allow", p);
});

test("default: everything open except settings", () => {
  const opts = {};
  for (const p of ["/", "/search", "/entity/x", "/red-lines", "/feedback", "/help"]) assert.equal(access(p, null, opts), "allow", p);
  for (const p of ["/settings", "/settings/two-factor"]) assert.equal(access(p, null, opts), "login", p);
});

test("a session without a second factor can only set one up", () => {
  const viewer = { twoFactorEnabled: false };
  for (const p of ["/", "/search", "/settings", "/red-lines"]) assert.equal(access(p, viewer), "enroll", p);
  assert.equal(access("/settings/two-factor", viewer), "allow");
  assert.equal(access("/login", viewer), "allow");
  assert.equal(access("/", viewer), "enroll");
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
  // `ip`: the client address Better Auth's rate limits count by.
  const post = (p: string, body: unknown, cookie = "", ip = "192.0.2.1") =>
    auth.handler(
      new Request(`${base}${p}`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://localhost:3000", cookie, "x-forwarded-for": ip },
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

  test("self-service signup creates an unverified account that can log in, once per address", async () => {
    await createAccount(db, "signup@example.com", "a-long-enough-password");
    const user = await (await auth.$context).internalAdapter.findUserByEmail("signup@example.com");
    assert.equal(user?.user.emailVerified, false);
    const res = await post("/sign-in/email", { email: "signup@example.com", password: "a-long-enough-password" });
    assert.equal(res.status, 200);
    await assert.rejects(createAccount(db, "signup@example.com", "another-long-password"), CliError);
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
    // Only a hash of the code is stored.
    const stored = (await db.execute(sql`select value from verifications where identifier like '2fa-otp-%'`)) as unknown as {
      rows: { value: string }[];
    };
    assert.equal(stored.rows.length, 1);
    assert.ok(!stored.rows[0]!.value.includes(code));

    assert.equal((await post("/two-factor/verify-otp", { code: "000000" }, pending)).status, 401);
    const step2 = await post("/two-factor/verify-otp", { code }, pending);
    assert.equal(step2.status, 200);
    const session = await auth.api.getSession({ headers: new Headers({ cookie: cookiesOf(step2) }) });
    assert.equal(session?.user.twoFactorEnabled, true);
    assert.equal(access("/", session!.user), "allow");
  });

  test("emailed codes follow the account's language", async () => {
    await db.execute(sql`update users set locale = 'fr' where email = ${TEST_ACCOUNT.email}`);
    const step1 = await post("/sign-in/email", { email: TEST_ACCOUNT.email, password: TEST_ACCOUNT.password });
    // Another address: this one just had a code (one every 30 seconds).
    assert.equal((await post("/two-factor/send-otp", {}, cookiesOf(step1), "192.0.2.2")).status, 200);
    assert.equal((await post("/two-factor/send-otp", {}, cookiesOf(step1), "192.0.2.2")).status, 429);
    assert.match(readDevMailbox(1)[0]!.subject, /^\d{6} est votre code Kwazat$/);
    await db.execute(sql`update users set locale = null where email = ${TEST_ACCOUNT.email}`);
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

test("dev gate: key from the environment, default only outside production", () => {
  assert.equal(devKey({ NODE_ENV: "development" } as NodeJS.ProcessEnv), "gloubi");
  assert.equal(devKey({ NODE_ENV: "production" } as NodeJS.ProcessEnv), null);
  assert.equal(devKey({ NODE_ENV: "production", DEV_ACCESS_KEY: "k" } as NodeJS.ProcessEnv), "k");
  const dev = { NODE_ENV: "development" } as NodeJS.ProcessEnv;
  assert.ok(isDevKey("gloubi", dev) && hasDevCookie("gloubi", dev));
  for (const bad of ["", "gloub", "gloubix", null, undefined]) assert.ok(!isDevKey(bad, dev) && !hasDevCookie(bad, dev), String(bad));
  assert.ok(!isDevKey("gloubi", { NODE_ENV: "production" } as NodeJS.ProcessEnv));
  assert.ok(devGateEnabled({ NODE_ENV: "development" }) && !devGateEnabled({ NODE_ENV: "development", DEV_GATE: "off" }));
});

test("password rules: length, no common or repetitive password, not the email", () => {
  assert.deepEqual(passwordIssues("a long passphrase of words", "x@y.fr"), []);
  assert.ok(passwordIssues("short", "").includes("short"));
  assert.ok(passwordIssues("Password123456", "").includes("common"));
  assert.ok(passwordIssues("abcabcabcabcabc", "").includes("repetitive"));
  assert.ok(passwordIssues("marie.dupont-2026-x", "marie.dupont@example.org").includes("email"));
  assert.ok(passwordIssues("x".repeat(129), "").includes("long"));
});

test("login and signup screens are public, their next page cannot loop back", () => {
  for (const p of ["/login/password", "/signup", "/signup/password"]) assert.equal(access(p, null, { loginEverywhere: true }), "allow", p);
  assert.equal(safeNextPath("/signup/password"), "/");
});
