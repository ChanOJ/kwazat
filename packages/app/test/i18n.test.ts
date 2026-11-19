import assert from "node:assert/strict";
import { test } from "node:test";
import { negotiate, resolveLocale } from "../src/i18n/locales.ts";
import { MESSAGES } from "../src/i18n/messages.ts";

test("the browser's language is used when nothing was chosen", () => {
  assert.equal(negotiate("fr-CH,fr;q=0.9,en;q=0.8"), "fr");
  assert.equal(negotiate("de-DE,de;q=0.9,fr;q=0.5,en;q=0.7"), "en");
  assert.equal(negotiate("de-DE,de;q=0.9"), "en");
  assert.equal(negotiate("en;q=0.1,fr;q=0.9"), "fr");
  assert.equal(negotiate("fr;q=0"), "en");
  assert.equal(negotiate(null), "en");
});

test("the account's choice beats the cookie, which beats the browser", () => {
  assert.equal(resolveLocale({ account: "en", cookie: "fr", acceptLanguage: "fr" }), "en");
  assert.equal(resolveLocale({ account: null, cookie: "fr", acceptLanguage: "en" }), "fr");
  assert.equal(resolveLocale({ account: "xx", cookie: "yy", acceptLanguage: "fr-FR" }), "fr");
});

test("French has exactly the messages of English, none empty except optional notes", () => {
  const flatten = (o: object, prefix = ""): Record<string, string> =>
    Object.entries(o).reduce(
      (acc, [k, v]) => ({ ...acc, ...(typeof v === "string" ? { [prefix + k]: v } : flatten(v, `${prefix}${k}.`)) }),
      {} as Record<string, string>,
    );
  const en = flatten(MESSAGES.en);
  const fr = flatten(MESSAGES.fr);
  assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort());
  for (const [key, value] of Object.entries(fr)) if (key !== "sheet.contentLanguage") assert.ok(value.trim(), key);
  // Same placeholders on both sides.
  const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of Object.keys(en)) assert.deepEqual(vars(fr[key]!), vars(en[key]!), key);
});

test("a follow-up call gets the login-step cookie just set, not a stale one", async () => {
  const { mergedCookies } = await import("../src/lib/cookies.ts");
  const set = new Headers();
  set.append("set-cookie", "better-auth.two_factor=new; Path=/; HttpOnly");
  assert.equal(
    mergedCookies("kwazat_locale=fr; better-auth.two_factor=old", set),
    "kwazat_locale=fr; better-auth.two_factor=new",
  );
});
