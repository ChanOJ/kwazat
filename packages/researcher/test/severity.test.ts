import assert from "node:assert/strict";
import { test } from "node:test";
import { severityOf } from "../src/severity.ts";

test("the model's severity is used when it is one of the four levels", () => {
  assert.equal(severityOf({ severity: "medium" }), "medium");
  assert.equal(severityOf({ severity: "low" }), "low");
  assert.equal(severityOf({ severity: "catastrophic" }), null);
  assert.equal(severityOf({}), null);
  assert.equal(severityOf(null), null);
});

test("structured fields override a contradicting severity", () => {
  assert.equal(severityOf({ severity: "high", overturned: true }), "cleared");
  assert.equal(severityOf({ severity: "medium", procedural_stage: "closed_without_charge" }), "cleared");
  assert.equal(severityOf({ severity: "low", matter_type: "conviction", is_final: true }), "high");
  assert.equal(severityOf({ severity: "low", matter_type: "conviction", is_final: false }), "low");
});
