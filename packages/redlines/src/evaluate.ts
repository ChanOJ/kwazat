/**
 * Deterministic evaluation of a user's red lines against one sheet. Pure: no I/O, no clock, no
 * randomness, so it runs identically on the server (tests) and in the browser.
 *
 * Verdicts (docs/design/red-lines.md, section 0):
 *   red   at least one strong match (established, final, published, short controlling chain);
 *   amber only weak matches (not final, appeal pending, ongoing proceedings, low confidence,
 *         minority stake, long chain, former or secondary link);
 *   grey  no match, but the data needed is missing (section not researched or awaiting review,
 *         controlling owner not resolved);
 *   none  no match in published data. Never read as "compatible" or "clean".
 */
import { GraphIndex, LINK_STRENGTH, MIN_LINK, STRONG_LINK, nodeOf, uniq, type Reached } from "./graph.ts";
import {
  OFFENSE_CLASSES,
  type Evaluation,
  type GraphEntity,
  type GraphFact,
  type Match,
  type OffenseClass,
  type RedLine,
  type RuleResult,
  type SheetGraph,
  type Verdict,
  type WeakReason,
} from "./types.ts";

type EntityType = GraphEntity["type"];

/** Sections of the subject a rule needs before "no match" can be said. */
const REQUIRED_SECTIONS: Record<RedLine["kind"], Partial<Record<EntityType, string[]>>> = {
  entity: { person: ["notable_relations"] },
  conviction: { person: ["convictions"], band: ["legal_proceedings", "members_conduct"] },
  proceedings: { person: ["ongoing_cases"], band: ["legal_proceedings", "members_conduct"] },
};

const VERDICT_ORDER: Verdict[] = ["red", "amber", "grey", "none"];

export function evaluate(rules: RedLine[], graph: SheetGraph): Evaluation {
  const index = new GraphIndex(graph);
  const walk = index.walk();
  const results = rules.map((rule) => evaluateRule(rule, index, walk.reached, walk.incomplete));
  return { verdict: worst(results.map((r) => r.verdict)), rules: results };
}

function evaluateRule(
  rule: RedLine,
  index: GraphIndex,
  reached: Map<string, Reached>,
  chainIncomplete: boolean,
): RuleResult {
  const matches =
    rule.kind === "entity"
      ? entityMatches(rule, index, reached)
      : factMatches(rule, index, reached);
  let verdict: Verdict;
  if (matches.some((m) => m.strength === "strong")) verdict = "red";
  else if (matches.length) verdict = "amber";
  else if (!covered(rule, index) || (chainIncomplete && (rule.kind !== "entity" || rule.includeIndirect))) verdict = "grey";
  else verdict = "none";
  return { ruleId: rule.id, verdict, matches };
}

/** True when every section the rule needs is researched and fully reviewed for the subject. */
function covered(rule: RedLine, index: GraphIndex): boolean {
  const subject = index.entities.get(index.graph.subjectId);
  if (!subject) return false;
  const needed = REQUIRED_SECTIONS[rule.kind][subject.type] ?? [];
  const states = index.graph.sections[subject.id] ?? {};
  return needed.every((s) => states[s] === "published");
}

// --- Entity rules -------------------------------------------------------------------------

function entityMatches(rule: Extract<RedLine, { kind: "entity" }>, index: GraphIndex, reached: Map<string, Reached>): Match[] {
  const isTarget = (node: string) => {
    if (node === rule.entityId) return true;
    if (!rule.wikidataId) return false;
    return node === `wd:${rule.wikidataId}` || index.entities.get(node)?.wikidataId === rule.wikidataId;
  };
  const subject = index.graph.subjectId;
  const matches: Match[] = [];

  if (isTarget(subject)) matches.push(match(rule.id, [], [], null));

  // Ownership chains and band membership first: for a one-hop chain, the share-aware reading
  // wins over the plain direct link (dedupe keeps the first match per relation path).
  if (rule.includeIndirect) {
    for (const [node, via] of reached) {
      if (isTarget(node)) matches.push(match(rule.id, via.path, via.reasons, null));
    }
  }

  // Direct links, in either direction, with a strength fixed by type.
  for (const r of index.touching(subject)) {
    const other = r.fromEntityId === subject ? nodeOf(r) : r.fromEntityId;
    if (other === subject || !isTarget(other)) continue;
    const strength = LINK_STRENGTH[r.relationType] ?? 1;
    if (strength < MIN_LINK) continue;
    const reasons: WeakReason[] = [];
    if (strength < STRONG_LINK) reasons.push("secondary_link");
    if (r.endedAt) reasons.push("former_link");
    const step = {
      relationId: r.id,
      relationType: r.relationType,
      fromEntityId: subject,
      toNode: other,
      toLabel: r.fromEntityId === subject ? r.toLabel : index.label(other),
      sharePct: r.sharePct,
      sources: r.sources,
    };
    matches.push(match(rule.id, [step], reasons, null));
  }

  return dedupe(matches);
}

// --- Fact rules (convictions, proceedings) ---------------------------------------------------

/** What a fact says, reduced to the fields the rules use. Null when the fact is not relevant. */
type Reading = {
  kind: "conviction" | "proceedings";
  offenseClass: OffenseClass | null;
  isFinal: boolean;
  appealPending: boolean;
};

const BAND_OPEN_STAGES = new Set(["investigation", "indicted", "first_instance", "appeal", "cassation"]);

/** Reads a fact of any supported section. Overturned and cleared matters are never read. */
export function readFact(fact: GraphFact): Reading | null {
  const d = fact.data;
  if (d.overturned === true || d.severity === "cleared" || d.procedural_stage === "closed_without_charge") return null;
  switch (fact.sectionId) {
    case "convictions": {
      const cls = (OFFENSE_CLASSES as readonly unknown[]).includes(d.offense_class) ? (d.offense_class as OffenseClass) : null;
      return { kind: "conviction", offenseClass: cls, isFinal: d.is_final === true, appealPending: d.appeal_pending === true };
    }
    case "ongoing_cases":
      return d.role === "suspect_or_defendant"
        ? { kind: "proceedings", offenseClass: null, isFinal: false, appealPending: false }
        : null;
    case "legal_proceedings": {
      // Band proceedings: a final decision of the highest severity is a conviction of the group.
      if (d.is_final === true) {
        return d.severity === "high" ? { kind: "conviction", offenseClass: null, isFinal: true, appealPending: false } : null;
      }
      return BAND_OPEN_STAGES.has(String(d.procedural_stage))
        ? { kind: "proceedings", offenseClass: null, isFinal: false, appealPending: false }
        : null;
    }
    case "members_conduct": {
      if (d.matter_type === "conviction") {
        return { kind: "conviction", offenseClass: null, isFinal: d.is_final === true, appealPending: false };
      }
      return d.matter_type === "charges_or_trial" || d.matter_type === "investigation"
        ? { kind: "proceedings", offenseClass: null, isFinal: false, appealPending: false }
        : null;
    }
    default:
      return null;
  }
}

function factMatches(
  rule: Extract<RedLine, { kind: "conviction" | "proceedings" }>,
  index: GraphIndex,
  reached: Map<string, Reached>,
): Match[] {
  const subject = index.graph.subjectId;
  const matches: Match[] = [];
  for (const fact of index.graph.facts) {
    if (fact.reviewStatus !== "published") continue;
    const via: Reached | undefined =
      fact.entityId === subject ? { node: subject, path: [], reasons: [] } : reached.get(fact.entityId);
    if (!via) continue;
    const reading = readFact(fact);
    if (!reading || reading.kind !== rule.kind) continue;

    const reasons: WeakReason[] = [...via.reasons];
    if (fact.confidence === "low") reasons.push("low_confidence");
    if (rule.kind === "proceedings") {
      reasons.push("ongoing_proceedings");
    } else {
      const min = OFFENSE_CLASSES.indexOf(rule.minOffenseClass);
      if (reading.offenseClass === null) {
        if (min > 0) reasons.push("unknown_offense_class");
      } else if (OFFENSE_CLASSES.indexOf(reading.offenseClass) < min) {
        continue;
      }
      if (!reading.isFinal) reasons.push("not_final");
      if (reading.appealPending) reasons.push("appeal_pending");
    }
    matches.push(match(rule.id, via.path, reasons, fact.id));
  }
  return matches;
}

// --- Helpers ---------------------------------------------------------------------------------

function match(ruleId: string, path: Match["path"], reasons: WeakReason[], factId: string | null): Match {
  const r = uniq(reasons);
  return { ruleId, strength: r.length ? "weak" : "strong", reasons: r, path, factId };
}

/** Keeps one match per evidence path (the same relation can be read from both ends). */
function dedupe(matches: Match[]): Match[] {
  const seen = new Set<string>();
  return matches.filter((m) => {
    const key = `${m.factId ?? ""}|${m.path.map((s) => s.relationId).join(">")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function worst(verdicts: Verdict[]): Verdict {
  for (const v of VERDICT_ORDER) if (verdicts.includes(v)) return v;
  return "none";
}
