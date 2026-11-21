/**
 * Input and output of red-line evaluation. Everything here is plain data so that the same
 * evaluation runs on the server (tests) and in the browser (red lines never leave the device in
 * clear, see docs/design/red-lines.md, section 0).
 */

export type ReviewStatus = "published" | "needs_review" | "rejected";
export type Confidence = "high" | "medium" | "low";

export type Source = { url: string; outlet: string; publishedAt: string | null };

export type GraphEntity = {
  id: string;
  type: "person" | "band" | "brand" | "product";
  label: string;
  wikidataId: string | null;
};

export type GraphFact = {
  id: string;
  entityId: string;
  sectionId: string;
  statement: string;
  data: Record<string, unknown>;
  confidence: Confidence;
  reviewStatus: ReviewStatus;
  sources: Source[];
};

export type GraphRelation = {
  id: string;
  fromEntityId: string;
  /** Null while the target has not been resolved into its own entity. */
  toEntityId: string | null;
  toWikidataId: string | null;
  toLabel: string;
  relationType: string;
  /** Ownership share in percent, when known. */
  sharePct: number | null;
  /** Set when the link is known to have ended (former member, former spouse...). */
  endedAt: string | null;
  reviewStatus: ReviewStatus;
  sources: Source[];
};

/**
 * State of a researched section for one entity. "published": researched and every fact
 * reviewed (an empty published section means nothing was found). "pending": some facts still
 * await review. A section missing from the map was never researched.
 */
export type SectionState = "published" | "pending";

/** The slice of the entity graph needed to evaluate one sheet: the subject and its neighbourhood. */
export type SheetGraph = {
  subjectId: string;
  entities: GraphEntity[];
  facts: GraphFact[];
  relations: GraphRelation[];
  sections: Record<string, Record<string, SectionState>>;
};

export const OFFENSE_CLASSES = ["petty_offense", "misdemeanor", "felony"] as const;
export type OffenseClass = (typeof OFFENSE_CLASSES)[number];

/** A user's red line. Kinds follow docs/design/red-lines.md, section 6. */
export type RedLine =
  | {
      id: string;
      kind: "entity";
      /** Kwazat id of the entity the user does not want to be tied to. */
      entityId: string;
      wikidataId: string | null;
      label: string;
      /** Also follow ownership chains and band membership, not only direct links. */
      includeIndirect: boolean;
    }
  | {
      id: string;
      kind: "conviction";
      /** Lowest offence class that matches. */
      minOffenseClass: OffenseClass;
    }
  | {
      id: string;
      kind: "proceedings";
    };

export type Verdict = "red" | "amber" | "none" | "grey";

/** Why a match is weak (amber). Neutral codes, translated by the UI. */
export type WeakReason =
  | "not_final"
  | "appeal_pending"
  | "ongoing_proceedings"
  | "low_confidence"
  | "unknown_offense_class"
  | "minority_stake"
  | "long_chain"
  | "former_link"
  | "secondary_link";

/** One hop of the path from the subject to the entity the evidence is about. */
export type PathStep = {
  relationId: string;
  relationType: string;
  fromEntityId: string;
  /** Entity id, or "wd:<Q-id>" / "label:<text>" when the target is not resolved. */
  toNode: string;
  toLabel: string;
  sharePct: number | null;
  sources: Source[];
};

export type Match = {
  ruleId: string;
  strength: "strong" | "weak";
  reasons: WeakReason[];
  /** Empty when the evidence is about the subject itself. */
  path: PathStep[];
  /** The fact behind the match, when it is a fact (conviction, proceedings). */
  factId: string | null;
};

export type RuleResult = {
  ruleId: string;
  verdict: Verdict;
  matches: Match[];
};

export type Evaluation = {
  verdict: Verdict;
  rules: RuleResult[];
};
