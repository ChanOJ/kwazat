# Red Lines: structuring proposal

Status: **decided, v1 in progress** (2026-11-21). Owner decisions are in section 0, which
supersedes sections 3 to 8 where they differ; the v1 scope is section 6.

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
- **Q3, fixed public thresholds, no per-user slider.**
  - Ownership chain: strong (red) when every hop gives control (share above 50 %, owner, parent
    organisation) and the chain has at most 3 hops; weak (amber) when a hop is a minority stake
    of at least 10 % or the chain has 4 or 5 hops. Stakes below 10 % are not followed; the walk
    stops at 5 hops.
  - Non-ownership links (ally, mentor, wedding witness, employer...) count only as direct links.
  - Link strength is fixed in code by relation type; the model's 1–5 rating is not used for
    matching.
- **Q4, no weights in v1** (no number).
- **Q8, red lines on sources later**: an outlet is a brand, so this follows the brand playbook.
- **Q9, controlled `topics[]`** on convictions, ongoing cases, revelations and controversies, for
  persons and bands. The list names subject matter, not judgement: corruption, fraud, tax,
  violence, sexual_violence, harassment, discrimination_or_hate_speech, environment,
  labour_rights, animal_welfare, public_health, data_privacy, other. The person playbook also
  gets the `severity` field the band playbook already has. New rule type: "topic X, at least
  amber". Cost: `item_schema` is not part of the research hash, so existing sheets re-run the
  extraction only (notes and corpus reused, no web search).
- **Q10, brand playbook right after v1.** v1 covers persons and bands (a rule on a person also
  matches bands they are or were members of). The brand playbook then takes ownership from
  Wikidata (P127, P749, share in qualifier P1107; free) plus one `ownership` research section for
  the gaps, paid only for new brands.
- **Political rules use party classifications chosen by the user, never a Kwazat label.**
  - There is no official definition of "far right" or "far left", and classifiers disagree
    (an official national classification can differ from common or academic usage).
  - Classifications apply to parties, not people. A person inherits them through current party
    membership (Wikidata P102 or the `political_affiliation` section); no party, no match. The
    model-written `orientation` field is no longer used for matching.
  - A rule reads "party classified X **according to** source S" (or "according to at least one
    source"). Candidate sources: official (e.g. France's Interior ministry election
    classification and its equivalents), academic (PopuList, Chapel Hill Expert Survey,
    ParlGov), Wikidata (P1387 political alignment).
  - The sheet shows every classification side by side with source and date, so disagreement is
    visible and the user sees which source triggered the match.
  - Data: `party_classifications(party_entity_id, source, value, as_of, url)`, filled by free
    imports. Check each dataset's redistribution licence before importing (public repository).

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

## 6. First version (v1)

Small PRs, one topic each, in this order:

1. **Pure `evaluate()`** in a package shared by server and browser: `evaluate(rules, sheet) →
   { verdict, matches[] }`, each match with its evidence (fact ids or relation path, sources,
   confidence, stage) and the rule that triggered it. Rule types: entity link (with ownership
   chains, section 0 thresholds), conviction (minimum `offense_class`, final only), ongoing
   proceedings (opt-in, amber), political (party classification + source). Published data only.
   Unit tests on fixture graphs with neutral placeholders (brand → company → holding → person,
   band → member). No storage, no UI.
2. **Encrypted storage and settings page** `/settings/red-lines` (replaces the placeholder at
   `/red-lines`): consent notice before the first rule, add/delete/disable, export JSON,
   delete all. Table `red_lines(user_id, ciphertext, key_wrap metadata, updated_at)`, ON DELETE
   CASCADE from `users`. Keys: device key + passkey PRF; QR linking and recovery key may follow
   in their own PR.
3. **Read side on the sheet**: the sheet sends the published facts and ownership subgraph; the
   browser decrypts the rules, runs `evaluate()` and shows the verdict and sourced matches, with
   the user's rule next to each match.
4. **Playbook changes**: `topics[]` and person `severity` (extraction-only re-run), then the topic
   rule type; fixed strengths by relation type.
5. **Party classifications** import (after licence checks) and the political rule's UI.
6. **Brand playbook** (Q10), then red lines on sources (Q8).

## 7. Open questions for the owner (all answered in section 0)

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

Build **A + B behind one `red_lines` store**, deterministic and evaluated on the client (section 0), with a **colour verdict plus a sourced explanation** per match; no LLM matching and no numeric score in v1. Start with the rule types of section 6, published data only, explicit Art. 9 consent, and no scan history. Revisit a 0–5 score and free-text (LLM) matching only after counsel review.
