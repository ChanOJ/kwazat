import assert from "node:assert/strict";
import { test } from "node:test";
import { matchMember } from "../src/members.ts";

const members = [{ label: "Till Lindemann" }, { label: "Richard Z. Kruspe" }, { label: "Christian Lorenz" }, { label: "Paul Landers" }, { label: "Oliver Riedel" }];

test("a member is found from the name written by the research step", () => {
  assert.equal(matchMember("Till Lindemann", members)?.label, "Till Lindemann");
  assert.equal(matchMember("till  LINDEMANN", members)?.label, "Till Lindemann");
  assert.equal(matchMember("Richard Kruspe", members)?.label, "Richard Z. Kruspe", "words of one name within the other");
  assert.equal(matchMember("Flake Lorenz", members)?.label, "Christian Lorenz", "same last name, only one");
  assert.equal(matchMember("Lindemann", members)?.label, "Till Lindemann");
});

test("an unknown or ambiguous name matches nobody", () => {
  assert.equal(matchMember("Doro Pesch", members), null);
  assert.equal(matchMember("", members), null);
  assert.equal(matchMember("Max Müller", [{ label: "Anna Müller" }, { label: "Jan Müller" }]), null);
});
