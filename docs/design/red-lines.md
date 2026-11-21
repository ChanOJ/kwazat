# Red Lines: structuring proposal

Status: **in design** (2026-11-21). Owner decisions are in section 0; questions 3, 4, 8, 9 and 10
of section 7 are still open. Update this file when they are answered.

## 0. Owner decisions (2026-11-21)

- **Q1, verdict colours first.** No 0–5 number in v1: a number needs weights, which are
  editorial choices. Revisit after counsel review.
  - Red: at least one strong match (established, final, published).
  - Amber: match on weak evidence (low confidence, pending appeal, long or weak chain).
  - "No match in published data": the needed sections are published and nothing matches. Never
    "compatible" or "clean".
  - Grey: not enough data (sheet not researched, sections `needs_review`, unknown ownership).
- **Q2, unknown ownership chain is grey**, never green.
- **Q5, pending appeal is amber.** Red only for a final, not overturned conviction. Ongoing
  proceedings (suspect or defendant) are a separate rule type the user opts into, always amber.
- **Q6, red lines are private, end-to-end encrypted, evaluated on the client.**
  - The server stores one encrypted blob per account (AES-GCM) and never holds the key: it
    cannot read red lines, even in memory.
  - Evaluation runs on the device: the server sends the sheet and the ownership subgraph it
    needs (published, public data) and the shared pure `evaluate()` runs in the browser or app.
    The server never learns the red lines nor the verdict. Trade-off accepted: no server-side
    alerts ("a new fact matches your red lines").
  - Keys, for users without a password manager (most people, or two unsynchronised ones:
    browser and mobile OS):
    1. a random data key, created on the first device, kept non-extractable on the device;
    2. wrapped with a passkey through the WebAuthn PRF extension, so OS-synced passkeys
       (iCloud, Google) unlock it on new devices with no user action (support per platform to
       be checked before building);
    3. device linking by QR code (ECDH, the server relays ciphertext only) when the passkey
       does not follow, e.g. across ecosystems;
    4. an optional recovery key, offered but never required.
  - Losing every device and passkey loses the red lines; they are quick to re-enter. The
    consent notice says so before the first rule is saved.
  - No sharing between users in v1; export (JSON) and delete-all from the settings page.
- **Q7, no search history on the server.** A "scan" is any consultation of a sheet by a
  logged-in user (search, sheet page, later a barcode scan): its history is a search history and
  is personal data. A local history in the browser or app is allowed for convenience. Server
  logs must not tie a user id to an entity id, with short retention.

## 1. What the initial design sessions said

- Original brief: logged-in users set "red lines" **in their preferences**, e.g. "a red flag if the sheet has a strong link to person X".
- Use case: someone in the street scans a person, brand or product and instantly sees a **compatibility score** against their convictions.
- Example: brand B → **0/5, in red**, because it is ultimately owned by person P and the user set a red flag on P.
- Architecture: "score computation (deterministic, per user)" in the API; score walks the **entity graph** (`relations`).
- The assistant's own points:
  - Ownership chains must be walked step by step (outlet → parent company → holding → owner), with percentages and dates.
  - Idea: apply red lines to **sources too** (a media outlet is itself a brand with an owner).
  - "Editorial interference" as a criterion needing first-rank proof.
  - Severity must rest on **objective criteria** (offence type, sentence), not an editorial grade: a grade would be an opinion.
  - Red lines and the score are personal data, stored server-side under GDPR.
  - Counsel review (press law + data protection) advised before any public opening.
  - Structured convictions plus a score are what GDPR Art. 10 targets; the journalistic exception (Art. 85) was the proposed route; lawyer review advised.
  - Source tiers: computed from public criteria, not the assistant's opinion. Same principle should hold for scoring.

## 2. What the data supports today

- `relations`: `relationType` (spouse_of, owner_of, shareholder_of, board_member_of, political_ally_of, member_of, employer_of…), `sharePct`, `strength` 1–5 (commented "used by red-line matching"), `toEntityId` (nullable while unresolved), `sources[]`, `reviewStatus`.
- `facts`: `sectionId`, free `statement`, structured `data` per section, `confidence` (high/medium/low), `sources[]` with outlet `tier`, `reviewStatus`.
- Structured fields usable as filters today:
  - `convictions`: `offense_class` (petty_offense / misdemeanor / felony), `offenses[]`, `is_final`, `overturned`, `appeal_pending`, `country`.
  - `ongoing_cases`: `role`, `procedural_status`.
  - `political_affiliation`: `orientation` (far_left … far_right), `parties[]`, `is_current`.
  - `controversies`, `investigative_revelations`: free text only (title, summary, perspectives).
- Only `published` rows may be used for scoring (sensitive sections start `needs_review`).
- Gaps:
  - No brand/product playbook yet (ownership comes from Wikidata + `notable_relations`).
  - No controlled topic tags on controversies.
  - `strength` is a model-assigned 1–5 for non-structural links; owner/spouse should be fixed by type, not by the model.
  - No transitive ownership computation (needs a graph walk with share multiplication).

## 3. Three models for what a red line is

### A. Entity red line ("I do not want anything tied to X")
- Rule = target entity + relation types + minimum strength/share + max hops.
- Data: `relations` (walk from the scanned entity to target; follow `owned_by` / `shareholder_of` / `owner_of` chains), `entities` for the target.
- Matches the original examples exactly (a named person, an owner reached through a brand's ownership chain).
- Pros: deterministic, explainable with a chain of sourced edges. Cons: user must name each entity; no way to say "any far-right party".

### B. Category red line (facts + severity threshold)
- Rule = fact category + threshold, e.g. "convictions with `offense_class` ≥ misdemeanor, final only", "political orientation in {far_right}", "ongoing case as defendant".
- Data: structured `facts.data` fields above; optionally propagated through ownership (brand owned by someone convicted).
- Pros: deterministic, uses objective criteria (matches the neutrality principle), covers many entities with one rule. Cons: limited to what playbooks structure; controversies cannot be filtered.

### C. Free-text value matched by an LLM
- Rule = sentence ("no links to arms trade", "no animal testing"); an LLM judges each sheet's facts against it.
- Pros: flexible, covers topics no schema anticipates. Cons: non-deterministic, costly per scan, opaque, hard to source-explain, and risks LLM-made opinions on people; also stores free-text opinions (more sensitive).
- Possible later, only as "suggested match, to verify", never as a score input.

A and B share one shape: `{ kind, target/category, thresholds, weight }`. They can be one table with a discriminated type.

## 4. From red lines to a score or verdict

- Per sheet, evaluate each red line → zero or more **matches**, each with its evidence: fact id or relation path, sources, confidence, procedural stage.
- Start with a **verdict**, not a number:
  - Red = at least one *strong* match (established, final, published).
  - Amber = match on weak evidence (low confidence, pending appeal, ≥ 3 hops, link strength ≤ 2) or unresolved entity.
  - Green = no match; say "no match in published data", never "compatible/clean": absence of data is not absence of fact.
  - Grey = sheet not yet researched or sections `needs_review`.
- Optional 0–5 later: 5 minus the weighted sum of matches, weights set by the *user* per red line (e.g. 1–3), with fixed, public rules for evidence strength. No editorial weight by Kwazat.
- Ownership propagation: multiply `sharePct` along the chain; attenuate by hop; majority/control = strong.
- Explanation block per match, always sourced:
  > "Brand B → owned by company C (100%, source, year) → controlled by holding H (…) → person P. Your red line: strong links to person P."
  Each hop links to its `sources[]` (outlet, date, quote) and shows `confidence` and `review` state.
- Compute at read time, on the client (section 0), deterministic, per user; never write verdicts or scores to the server.

## 5. Neutrality and GDPR

- **Special-category data (Art. 9)**: red lines reveal political opinions, possibly religious or philosophical beliefs, health, sexual orientation. Even innocuous-looking lists ("no far-right links") reveal them. Required: explicit consent (Art. 9(2)(a)), purpose limitation, minimisation, DPIA (large-scale sensitive data), encryption at rest, export and delete from the settings page, retention limit, no use for ads or analytics, no sharing.
- Do not log scanned entities per user in a way that profiles them: **scan history is inferential data too**. Prefer not storing it, or opt-in with deletion.
- Red lines never reach the server in clear (section 0): not in logs, error trackers, URLs or LLM prompts (model C would send them to a processor: avoid for now).
- Entity data side: convictions fall under Art. 10; keep journalistic-exception framing, `published`-only scoring, presumption of innocence (pending appeal = amber, not red), correct overturned rulings.
- Neutrality: Kwazat states facts; **the user** makes the judgment. Wording: "matches your red line X", never "bad/dangerous". Fixed public rules, no hidden weights. Colour = user's own criteria; show the user's rule next to each match.
- Avoid a built-in catalogue of "suggested red lines" ranking political camps: that is an editorial stance. If presets are offered, make them objective (e.g. "final convictions for corruption") and neutral across orientations.
- Staff and auditors should not read user red lines: separate table, restricted access.
- Counsel review (press law + data protection) before opening beyond the owner.

## 6. Minimal first version (UI)

Page `/settings/red-lines` (behind login, consistent with `/settings`; header noindex). Phase 1, local only:

- List of the user's red lines + "Add" form with a type selector:
  1. **Entity link**: pick an entity (existing search/autocomplete) + minimum strength (default 3) + "include ownership chains" checkbox.
  2. **Convictions**: minimum `offense_class`, "final only" toggle (default on).
  3. **Political orientation**: multi-select of `orientation` values, "current only" toggle.
- Delete / disable per rule. Explicit notice about sensitive data and a "delete all my red lines" button; consent checkbox shown before the first rule is saved.
- Storage: one encrypted blob per user, `red_lines(user_id, ciphertext, key_wrap metadata, updated_at)`; ON DELETE CASCADE from `users`; the server cannot read it (section 0).
- Read side (small follow-up): on the entity sheet for a logged-in user, a banner "Red lines: N matches" with the evidence list and sources. No numeric score yet.
- Tests: pure function `evaluate(redLines, entityGraph, facts) → matches`, unit-tested with fixture graphs (brand → company → holding → person chain).

## 7. Open questions for the owner

1. Verdict colours first, or a 0–5 number from day one? (The brief says 0/5.)
2. Should an unresolved ownership chain (no data) show grey/"unknown" or green? Recommendation: grey.
3. Hop limit and attenuation: is a 3-hop ownership chain "strong"? Who sets thresholds: fixed public rules or per-user slider?
4. Per-red-line weights set by the user, or all equal?
5. Does a pending appeal count as a match? (Recommend amber.)
6. Are red lines private forever, or shareable between users (profile / friends)? Sharing multiplies the Art. 9 risk.
7. Is scan history kept? (Recommend no by default.)
8. Do red lines apply to sources (outlets owned by X) too, as discussed in the initial design?
9. Controversies and revelations have no structured tags: add a controlled `topics[]` to the playbook (needs a playbook version bump and re-run), or leave them out of matching?
10. Brand and product playbooks: priority vs the Red Lines page? Entity red lines on brands need the ownership data.

## 8. Recommendation

Build **A + B behind one `red_lines` store**, deterministic and evaluated on the client (section 0), with a **colour verdict plus a sourced explanation** per match; no LLM matching and no numeric score in v1. Start with three rule types (entity link with ownership chains, conviction severity, political orientation), published data only, explicit Art. 9 consent, and no scan history. Add the 0–5 score and free-text topics once brand ownership data exists and counsel has reviewed.
