import assert from "node:assert/strict";
import { test } from "node:test";
import { newDataKey, newDeviceKey, newWrapId, open, seal, unwrapDataKey, wrapDataKey, type Vault } from "../src/vault.ts";

const VAULT: Vault = {
  version: 1,
  consentAt: "2026-11-21T10:00:00.000Z",
  rules: [{ id: "r1", kind: "conviction", minOffenseClass: "felony", enabled: true, createdAt: "2026-11-21T10:00:00.000Z" }],
};
const NOW = new Date("2026-11-21T10:00:00Z");

test("a vault sealed with the data key opens with the same key and user", async () => {
  const key = await newDataKey();
  const sealed = await seal(VAULT, key, "user-1");
  assert.ok(!sealed.ciphertext.includes("felony"));
  assert.deepEqual(await open(sealed, key, "user-1"), VAULT);
});

test("a vault does not open for another user or with another key, nor when tampered with", async () => {
  const key = await newDataKey();
  const sealed = await seal(VAULT, key, "user-1");
  await assert.rejects(open(sealed, key, "user-2"));
  await assert.rejects(open(sealed, await newDataKey(), "user-1"));
  const bytes = Buffer.from(sealed.ciphertext, "base64");
  bytes[0] = bytes[0]! ^ 1;
  await assert.rejects(open({ ...sealed, ciphertext: bytes.toString("base64") }, key, "user-1"));
});

test("the data key survives a device wrap, which is bound to the user", async () => {
  const dataKey = await newDataKey();
  const deviceKey = await newDeviceKey();
  const wrap = await wrapDataKey(dataKey, deviceKey, "user-1", newWrapId(), NOW);
  assert.equal(wrap.createdAt, NOW.toISOString());
  const sealed = await seal(VAULT, dataKey, "user-1");
  const unwrapped = await unwrapDataKey(wrap, deviceKey, "user-1");
  assert.deepEqual(await open(sealed, unwrapped, "user-1"), VAULT);
  await assert.rejects(unwrapDataKey(wrap, deviceKey, "user-2"));
  await assert.rejects(unwrapDataKey(wrap, await newDeviceKey(), "user-1"));
});

test("the device key cannot be exported", async () => {
  await assert.rejects(crypto.subtle.exportKey("raw", await newDeviceKey()));
});
