import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { clientIp, hit, LIMITS, passwordChecks, resetLimits, sendChecks } from "../src/lib/rate-limit.ts";

beforeEach(resetLimits);

test("one emailed code every 30 seconds, then 5 per hour per account", () => {
  const t0 = 1_000_000_000;
  assert.equal(hit(sendChecks("1.2.3.4", "a@x"), t0), 0);
  assert.equal(hit(sendChecks("1.2.3.4", "a@x"), t0 + 10_000), 20);
  // The refused attempt is not counted: the wait does not grow.
  assert.equal(hit(sendChecks("1.2.3.4", "a@x"), t0 + 29_000), 1);
  for (let i = 1; i < LIMITS.sendPerHour.max; i++) assert.equal(hit(sendChecks("1.2.3.4", "a@x"), t0 + i * 31_000), 0);
  const wait = hit(sendChecks("5.6.7.8", "a@x"), t0 + 10 * 31_000);
  assert.ok(wait > 30 * 60, `hourly cap, wait ${wait}`);
  // Another account from another address is not affected.
  assert.equal(hit(sendChecks("5.6.7.8", "b@x"), t0 + 10 * 31_000), 0);
});

test("password checks: 5 a minute per address, 10 per 15 minutes per account", () => {
  const t0 = 2_000_000_000;
  for (let i = 0; i < 5; i++) assert.equal(hit(passwordChecks("ip1", "a@x"), t0 + i), 0);
  assert.ok(hit(passwordChecks("ip1", "a@x"), t0 + 10) > 0);
  // From other addresses, the account still stops at 10.
  for (let i = 0; i < 5; i++) assert.equal(hit(passwordChecks(`ip${i + 2}`, "a@x"), t0 + 100 + i), 0);
  assert.ok(hit(passwordChecks("ip9", "a@x"), t0 + 200) > 60);
  assert.equal(hit(passwordChecks("ip1", "a@x"), t0 + 61_000) > 0, true, "account window still full");
});

test("the client address is the one the proxy appended", () => {
  assert.equal(clientIp(new Headers({ "x-forwarded-for": "6.6.6.6, 10.0.0.1" })), "10.0.0.1");
  assert.equal(clientIp(new Headers()), "local");
});
