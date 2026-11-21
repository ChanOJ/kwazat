/**
 * Walking the entity graph from a sheet's subject. The thresholds are fixed and public
 * (docs/design/red-lines.md, section 0, Q3): no per-user slider, no model-assigned weight.
 */
import type { GraphEntity, GraphRelation, PathStep, SheetGraph, WeakReason } from "./types.ts";

/** Longest ownership or membership chain followed. */
export const MAX_HOPS = 5;
/** Longer chains are weak (amber) even when every hop gives control. */
export const STRONG_MAX_HOPS = 3;
/** Above this share, a stake gives control. */
export const CONTROL_SHARE_PCT = 50;
/** Below this share, a stake is not followed at all. */
export const MIN_SHARE_PCT = 10;

/**
 * Strength of a direct link, fixed by its type (1 anecdotal .. 5 structural). The model's own
 * rating is not used for matching. Unknown types count as 1.
 */
export const LINK_STRENGTH: Record<string, number> = {
  spouse_of: 5,
  partner_of: 5,
  parent_of: 5,
  child_of: 5,
  owner_of: 5,
  owned_by: 5,
  subsidiary_of: 5,
  parent_organization: 5,
  has_member: 5,
  sibling_of: 4,
  business_partner_of: 4,
  board_member_of: 4,
  member_of_party: 4,
  former_spouse_of: 3,
  employer_of: 3,
  employee_of: 3,
  shareholder_of: 3,
  political_mentor_of: 3,
  political_ally_of: 3,
  member_of: 3,
  wedding_witness_of: 2,
  other: 1,
};
/** Direct links at or above this strength are strong; weaker ones (2-3) are amber; 1 is ignored. */
export const STRONG_LINK = 4;
export const MIN_LINK = 2;

/** Edge types where the `to` side controls the `from` side (subsidiary -> parent). */
const CONTROLLED_BY = new Set(["owned_by", "subsidiary_of", "parent_organization"]);
/** Edge types where the `from` side owns a stake in the `to` side. */
const STAKE_IN = new Set(["owner_of", "shareholder_of"]);

/** A node of the walk: an entity id, or a stand-in for an unresolved target. */
export function nodeOf(r: GraphRelation): string {
  if (r.toEntityId) return r.toEntityId;
  if (r.toWikidataId) return `wd:${r.toWikidataId}`;
  return `label:${r.toLabel}`;
}

export type Reached = {
  node: string;
  path: PathStep[];
  reasons: WeakReason[];
};

export type Walk = {
  /** Best path to every node reached through ownership or membership, the subject excluded. */
  reached: Map<string, Reached>;
  /** A controlling owner could not be followed (unresolved entity): the chain is incomplete. */
  incomplete: boolean;
};

type Hop = { relation: GraphRelation; next: string; nextLabel: string; reason: WeakReason | null };

export class GraphIndex {
  readonly entities = new Map<string, GraphEntity>();
  private readonly byFrom = new Map<string, GraphRelation[]>();
  private readonly byTo = new Map<string, GraphRelation[]>();

  constructor(readonly graph: SheetGraph) {
    for (const e of graph.entities) this.entities.set(e.id, e);
    for (const r of graph.relations) {
      if (r.reviewStatus !== "published") continue;
      push(this.byFrom, r.fromEntityId, r);
      push(this.byTo, nodeOf(r), r);
    }
  }

  /** Published relations touching a node, in either direction. */
  touching(node: string): GraphRelation[] {
    return [...(this.byFrom.get(node) ?? []), ...(this.byTo.get(node) ?? [])];
  }

  label(node: string): string {
    return this.entities.get(node)?.label ?? node.replace(/^(wd|label):/, "");
  }

  /** Edges that attach `node` to something it depends on: a controlling owner, or a band member. */
  private hops(node: string): { hops: Hop[]; blocked: boolean } {
    const hops: Hop[] = [];
    let blocked = false;
    for (const r of this.byFrom.get(node) ?? []) {
      if (CONTROLLED_BY.has(r.relationType)) {
        const reason = stakeReason(r.sharePct, true);
        if (reason !== "skip") hops.push({ relation: r, next: nodeOf(r), nextLabel: r.toLabel, reason });
      } else if (r.relationType === "has_member") {
        hops.push({ relation: r, next: nodeOf(r), nextLabel: r.toLabel, reason: r.endedAt ? "former_link" : null });
      }
    }
    for (const r of this.byTo.get(node) ?? []) {
      if (!STAKE_IN.has(r.relationType)) continue;
      const reason = stakeReason(r.sharePct, r.relationType === "owner_of");
      if (reason === "skip") continue;
      const owner = r.fromEntityId;
      hops.push({ relation: r, next: owner, nextLabel: this.label(owner), reason });
    }
    // A controlling owner that is not resolved into an entity cannot be followed further.
    for (const h of hops) {
      if (h.reason === null && h.relation.relationType !== "has_member" && !this.entities.has(h.next)) blocked = true;
    }
    return { hops, blocked };
  }

  /** Every node reachable from the subject through ownership and membership, with its best path. */
  walk(): Walk {
    const subject = this.graph.subjectId;
    const reached = new Map<string, Reached>();
    let incomplete = false;
    const visit = (node: string, path: PathStep[], reasons: WeakReason[], seen: Set<string>) => {
      if (path.length >= MAX_HOPS) return;
      const { hops, blocked } = this.hops(node);
      if (blocked) incomplete = true;
      for (const h of hops) {
        if (seen.has(h.next)) continue;
        const step: PathStep = {
          relationId: h.relation.id,
          relationType: h.relation.relationType,
          fromEntityId: node,
          toNode: h.next,
          toLabel: h.nextLabel,
          sharePct: h.relation.sharePct,
          sources: h.relation.sources,
        };
        const nextPath = [...path, step];
        const nextReasons = uniq([
          ...reasons,
          ...(h.reason ? [h.reason] : []),
          ...(nextPath.length > STRONG_MAX_HOPS ? (["long_chain"] as const) : []),
        ]);
        const candidate: Reached = { node: h.next, path: nextPath, reasons: nextReasons };
        const best = reached.get(h.next);
        if (!best || better(candidate, best)) reached.set(h.next, candidate);
        visit(h.next, nextPath, nextReasons, new Set([...seen, h.next]));
      }
    };
    visit(subject, [], [], new Set([subject]));
    return { reached, incomplete };
  }
}

/** Weak reason of a stake, null when it gives control, "skip" when it is too small to follow. */
function stakeReason(sharePct: number | null, controlWhenUnknown: boolean): WeakReason | null | "skip" {
  if (sharePct === null) return controlWhenUnknown ? null : "minority_stake";
  if (sharePct > CONTROL_SHARE_PCT) return null;
  if (sharePct >= MIN_SHARE_PCT) return "minority_stake";
  return "skip";
}

function better(a: Reached, b: Reached): boolean {
  const strongA = a.reasons.length === 0;
  const strongB = b.reasons.length === 0;
  if (strongA !== strongB) return strongA;
  if (a.reasons.length !== b.reasons.length) return a.reasons.length < b.reasons.length;
  return a.path.length < b.path.length;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

export function uniq<T>(items: T[]): T[] {
  return [...new Set(items)];
}
