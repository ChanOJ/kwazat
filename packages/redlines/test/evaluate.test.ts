import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/evaluate.ts";
import type { RedLine } from "../src/types.ts";
import { BAND_SECTIONS, PERSON_SECTIONS, conviction, entity, fact, graph, rel } from "./fixtures.ts";

const onPerson = (entityId: string, includeIndirect = true, wikidataId: string | null = null): RedLine => ({
  id: "rule-entity",
  kind: "entity",
  entityId,
  wikidataId,
  label: entityId,
  includeIndirect,
});
const convictions = (min: "petty_offense" | "misdemeanor" | "felony" = "misdemeanor"): RedLine => ({
  id: "rule-conviction",
  kind: "conviction",
  minOffenseClass: min,
});
const proceedings: RedLine = { id: "rule-proceedings", kind: "proceedings" };

// Brand B -> Company C (owned_by, 100 %) -> Holding H (owned_by, 60 %) <- Person P (owner_of).
function chain() {
  return graph("B", {
    entities: [entity("B", "brand"), entity("C", "brand"), entity("H", "brand"), entity("P")],
    relations: [
      rel("B", "owned_by", "C", { sharePct: 100 }),
      rel("C", "owned_by", "H", { sharePct: 60 }),
      rel("P", "owner_of", "H"),
    ],
  });
}

test("a controlling ownership chain of three hops is a strong match, with the full path", () => {
  const result = evaluate([onPerson("P")], chain());
  assert.equal(result.verdict, "red");
  const [m] = result.rules[0]!.matches;
  assert.equal(m?.strength, "strong");
  assert.deepEqual(m?.path.map((s) => s.toNode), ["C", "H", "P"]);
  assert.ok(m?.path.every((s) => s.sources.length > 0));
});

test("indirect links are ignored when the rule asks for direct links only", () => {
  const result = evaluate([onPerson("P", false)], chain());
  assert.equal(result.verdict, "none");
});

test("a minority stake makes the chain weak, a stake under 10 % is not followed", () => {
  const minority = chain();
  minority.relations[1]!.sharePct = 30;
  const weak = evaluate([onPerson("P")], minority);
  assert.equal(weak.verdict, "amber");
  assert.deepEqual(weak.rules[0]!.matches[0]?.reasons, ["minority_stake"]);

  const tiny = chain();
  tiny.relations[1]!.sharePct = 5;
  assert.equal(evaluate([onPerson("P")], tiny).verdict, "none");
});

test("chains longer than three hops are weak, longer than five are not followed", () => {
  const ids = ["B", "C1", "C2", "C3", "C4", "C5", "C6"];
  const build = (length: number) =>
    graph("B", {
      entities: ids.map((id) => entity(id, "brand")),
      relations: ids.slice(0, length).map((id, i) => rel(id, "owned_by", ids[i + 1]!)),
    });
  assert.equal(evaluate([onPerson("C3")], build(3)).verdict, "red");
  const four = evaluate([onPerson("C4")], build(4));
  assert.equal(four.verdict, "amber");
  assert.deepEqual(four.rules[0]!.matches[0]?.reasons, ["long_chain"]);
  assert.equal(evaluate([onPerson("C5")], build(5)).verdict, "amber");
  assert.equal(evaluate([onPerson("C6")], build(6)).verdict, "none");
});

test("an unresolved controlling owner makes 'no match' grey, but still matches by Wikidata id", () => {
  const g = graph("B", {
    entities: [entity("B", "brand")],
    relations: [rel("B", "owned_by", null, { toWikidataId: "Q1", toLabel: "Owner Co" })],
  });
  assert.equal(evaluate([onPerson("X")], g).verdict, "grey");
  assert.equal(evaluate([onPerson("X", true, "Q1")], g).verdict, "red");
});

test("cycles in the ownership graph terminate", () => {
  const g = graph("B", {
    entities: [entity("B", "brand"), entity("C", "brand")],
    relations: [rel("B", "owned_by", "C"), rel("C", "owned_by", "B")],
  });
  assert.equal(evaluate([onPerson("P")], g).verdict, "none");
});

test("direct links: strength fixed by type, former links weak, anecdotal links ignored", () => {
  const sections = { S: PERSON_SECTIONS };
  const base = [entity("S"), entity("P")];
  const g = (r: ReturnType<typeof rel>) => graph("S", { entities: base, relations: [r], sections });
  assert.equal(evaluate([onPerson("P")], g(rel("S", "spouse_of", "P"))).verdict, "red");
  const ally = evaluate([onPerson("P")], g(rel("S", "political_ally_of", "P")));
  assert.equal(ally.verdict, "amber");
  assert.deepEqual(ally.rules[0]!.matches[0]?.reasons, ["secondary_link"]);
  const former = evaluate([onPerson("P")], g(rel("S", "spouse_of", "P", { endedAt: "2020" })));
  assert.deepEqual(former.rules[0]!.matches[0]?.reasons, ["former_link"]);
  assert.equal(evaluate([onPerson("P")], g(rel("S", "other", "P"))).verdict, "none");
  // Links stored on the other entity's side count too.
  assert.equal(evaluate([onPerson("P")], g(rel("P", "business_partner_of", "S"))).verdict, "red");
});

test("the sheet of the red-lined entity itself is a strong match", () => {
  const g = graph("P", { entities: [entity("P")], sections: { P: PERSON_SECTIONS } });
  assert.equal(evaluate([onPerson("P")], g).verdict, "red");
});

test("unpublished relations and facts are never used", () => {
  const g = graph("S", {
    entities: [entity("S"), entity("P")],
    relations: [rel("S", "spouse_of", "P", { reviewStatus: "needs_review" })],
    facts: [fact("S", "convictions", conviction(), { reviewStatus: "needs_review" })],
    sections: { S: PERSON_SECTIONS },
  });
  const result = evaluate([onPerson("P"), convictions()], g);
  assert.equal(result.verdict, "none");
});

test("a person sheet without the needed sections published is grey, not 'no match'", () => {
  const missing = graph("S", { entities: [entity("S")], sections: { S: { convictions: "published" } } });
  const result = evaluate([onPerson("P"), convictions(), proceedings], missing);
  assert.deepEqual(result.rules.map((r) => r.verdict), ["grey", "none", "grey"]);
  assert.equal(result.verdict, "grey");
  const pending = graph("S", { entities: [entity("S")], sections: { S: { ...PERSON_SECTIONS, convictions: "pending" } } });
  assert.equal(evaluate([convictions()], pending).verdict, "grey");
});

test("convictions: final is red; not final, appeal pending or low confidence are amber; overturned ignored", () => {
  const g = (data: Record<string, unknown>, confidence: "high" | "low" = "high") =>
    graph("S", { entities: [entity("S")], facts: [fact("S", "convictions", data, { confidence })], sections: { S: PERSON_SECTIONS } });
  assert.equal(evaluate([convictions()], g(conviction())).verdict, "red");
  const notFinal = evaluate([convictions()], g(conviction({ is_final: false, appeal_pending: true, procedural_stage: "first_instance" })));
  assert.equal(notFinal.verdict, "amber");
  assert.deepEqual(notFinal.rules[0]!.matches[0]?.reasons, ["not_final", "appeal_pending"]);
  assert.equal(evaluate([convictions()], g(conviction(), "low")).verdict, "amber");
  assert.equal(evaluate([convictions()], g(conviction({ overturned: true }))).verdict, "none");
});

test("convictions: the minimum offence class filters, an unknown class is amber above the lowest class", () => {
  const g = (cls: string) =>
    graph("S", { entities: [entity("S")], facts: [fact("S", "convictions", conviction({ offense_class: cls }))], sections: { S: PERSON_SECTIONS } });
  assert.equal(evaluate([convictions("felony")], g("misdemeanor")).verdict, "none");
  assert.equal(evaluate([convictions("misdemeanor")], g("felony")).verdict, "red");
  const unknown = evaluate([convictions("misdemeanor")], g("unknown"));
  assert.deepEqual(unknown.rules[0]!.matches[0]?.reasons, ["unknown_offense_class"]);
  assert.equal(evaluate([convictions("petty_offense")], g("unknown")).verdict, "red");
});

test("ongoing proceedings as defendant are always amber; as witness they do not match", () => {
  const g = (role: string) =>
    graph("S", {
      entities: [entity("S")],
      facts: [fact("S", "ongoing_cases", { case_name: "Case 2", role, procedural_status: "indicted" })],
      sections: { S: PERSON_SECTIONS },
    });
  const defendant = evaluate([proceedings], g("suspect_or_defendant"));
  assert.equal(defendant.verdict, "amber");
  assert.deepEqual(defendant.rules[0]!.matches[0]?.reasons, ["ongoing_proceedings"]);
  assert.equal(evaluate([proceedings], g("witness")).verdict, "none");
});

test("a rule on a person matches the bands they are members of; former members are weak", () => {
  const g = (endedAt: string | null) =>
    graph("G", {
      entities: [entity("G", "band"), entity("M")],
      relations: [rel("G", "has_member", "M", { endedAt })],
      sections: { G: BAND_SECTIONS },
    });
  assert.equal(evaluate([onPerson("M")], g(null)).verdict, "red");
  const former = evaluate([onPerson("M")], g("2010"));
  assert.equal(former.verdict, "amber");
  assert.deepEqual(former.rules[0]!.matches[0]?.reasons, ["former_link"]);
});

test("band: members' convictions reach the band through the member's sheet and members_conduct", () => {
  const g = graph("G", {
    entities: [entity("G", "band"), entity("M")],
    relations: [rel("G", "has_member", "M")],
    facts: [
      fact("M", "convictions", conviction()),
      fact("G", "members_conduct", { member: "M", matter_type: "conviction", procedural_stage: "final", is_final: true, severity: "high" }),
      fact("G", "members_conduct", { member: "M", matter_type: "investigation", procedural_stage: "investigation", is_final: false, severity: "medium" }),
    ],
    sections: { G: BAND_SECTIONS },
  });
  const result = evaluate([convictions("petty_offense"), proceedings], g);
  const [conv, proc] = result.rules;
  assert.equal(conv?.verdict, "red");
  assert.equal(conv?.matches.length, 2);
  assert.deepEqual(conv?.matches.find((m) => m.path.length)?.path.map((s) => s.toNode), ["M"]);
  assert.equal(proc?.verdict, "amber");
});

test("band: final high-severity proceedings are a conviction, open ones are proceedings, cleared ones nothing", () => {
  const g = (data: Record<string, unknown>) =>
    graph("G", { entities: [entity("G", "band")], facts: [fact("G", "legal_proceedings", data)], sections: { G: BAND_SECTIONS } });
  assert.equal(evaluate([convictions("petty_offense")], g({ is_final: true, severity: "high", procedural_stage: "final" })).verdict, "red");
  assert.equal(evaluate([proceedings], g({ is_final: false, severity: "medium", procedural_stage: "indicted" })).verdict, "amber");
  assert.equal(evaluate([proceedings, convictions()], g({ is_final: true, severity: "cleared", procedural_stage: "final" })).verdict, "none");
});

test("a conviction of a controlling owner reaches the brand", () => {
  const g = chain();
  g.facts = [fact("P", "convictions", conviction())];
  const result = evaluate([convictions()], g);
  assert.equal(result.verdict, "red");
  assert.deepEqual(result.rules[0]!.matches[0]?.path.map((s) => s.toNode), ["C", "H", "P"]);
});

test("the overall verdict is the worst rule verdict; no rules means none", () => {
  const g = graph("S", {
    entities: [entity("S"), entity("P")],
    relations: [rel("S", "political_ally_of", "P")],
    sections: { S: { notable_relations: "published" } },
  });
  const result = evaluate([onPerson("P"), convictions()], g);
  assert.deepEqual(result.rules.map((r) => r.verdict), ["amber", "grey"]);
  assert.equal(result.verdict, "amber");
  assert.equal(evaluate([], g).verdict, "none");
});

test("evaluation is deterministic", () => {
  const g = chain();
  assert.deepEqual(evaluate([onPerson("P"), convictions()], g), evaluate([onPerson("P"), convictions()], g));
});
