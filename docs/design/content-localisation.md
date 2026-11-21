# Sheet content localisation

Status: **proposal** (2026-11-19), with the owner decisions below. Update this file when the
plan changes.

## 0. Owner decisions (2026-11-19)

- Alpha: sheet content in English with a French UI is fine (answers question 1 of section 7).
- Machine translation of sensitive sections (convictions, ongoing cases, revelations) is
  acceptable until the end of the beta; ask again before full public opening (question 2).
- Languages after French come one by one, on request (question 3).
- The plan of section 6 is the agreed direction.

## 1. What was decided in the initial design sessions

- Owner: the system is worldwide and agnostic like Wikidata; "English everywhere, translate/localise the results later in the web app".
- Assistant's follow-ups, accepted without objection:
  - Sheets are written in English; "translation will happen in the web app".
  - API serves English sheets with **neutral codes** (procedural stage, relation type, orientation...) that the front translates. Translating sheet *content* was explicitly deferred ("later").
  - Name search: entities stored "with labels and aliases in all languages" (trigram search over `entity_names`).
  - Inclusive-writing rules must later apply to UI strings and French/German/Italian sheets; sheets about real people keep the person's gender.
  - Quotes and their translations stay faithful to the author's words (project rule).
- Nothing was decided about the *mechanism* of content translation, caching, or cost. Open.

## 2. How data is stored today

| Data | Stored as | Localisable how |
|---|---|---|
| `entities.label`, `description`, `aliases` | one value, picked by `pick()` in `wikidata.ts`: first of `LANGS = [en, mul, fr, de, es, it]` | Wikidata has per-language labels/descriptions; only the English one is kept in `entities` |
| `entity_names` | all labels + aliases of those 6 languages with `lang` (for search) | Labels in fr/de/es/it are **already in the DB** for the entity itself |
| `entities.identity` | `gender`, `nationalities[]`, `occupations[]` as **English label strings** (not Q-ids) | Can't be re-labelled without the Q-ids; store ids (`P27`, `P106` values) next to labels |
| `relations.toLabel` | English label; `toWikidataId` when known | Same: label via Wikidata id, else `entities.label` of `toEntityId` |
| `facts.statement` | English sentence, written by Claude, attributed | Needs translation |
| `facts.data` | structured JSON; enums (`offense_class`, `procedural_stage`, `orientation`...) + free strings (`case_name`, `offenses[]`, `allegations`, `summary`, `perspectives[].position`, `sentence`) | Enums: UI dictionary. Free strings: translation |
| `relations.description` | English free text | Translation |
| `facts.sources[]` | `outlet`, `url`, `quote` in the **original language** | Do not translate by default |

## 3. Options

### A. Wikidata labels per language (entity names, descriptions, identity fields)
- Free, deterministic, sourced. Extend what exists: fetch the target language label/description at view time or at research time and cache in a table `entity_labels(entity_id, lang, label, description)`; `entity_names` already has labels per language for 6 languages.
- Make `identity` store Q-ids (nationality, occupations, gender) so the UI can show localised labels via a label cache `(qid, lang) → label`.
- Fallback when a language label is missing: English label (never machine-translate a proper name).
- Cost: nothing meaningful (one batched `wbgetentities` per language per sheet, cached).

### B. UI dictionary for codes (enums, relation types, section titles, stages)
- Zero-LLM, zero-risk. Already the initial design plan. Section titles and `relation_types` go in the next-intl catalogues.

### C. LLM translation of free text (statements, descriptions, `case_name`, summaries)
- C1. **At research time**: extraction step also emits French (or all target languages). Pros: translation sees the sources; cheap incremental call. Cons: multiplies output tokens by the number of languages for every sheet whether read or not; changes every playbook schema; re-run of all sheets to add a language.
- C2. **On first view, cached per (fact, language)**: table `fact_translations(fact_id, lang, statement, data_text jsonb, source_hash, model, created_at)`. Translate only the `published` facts of a sheet the first time a user in that language opens it; invalidate by `source_hash` (hash of the English statement + translatable fields), so a changed fact is retranslated, and a deleted fact cascades. Same for `relations.description`.
- C2 is recommended: pay only for what is read, languages can be added without re-research, no playbook change.
- Translate from the **English statement only**, not from the sources, with a strict prompt: preserve attribution ("According to X"), hedges, procedural stage, dates, names, numbers; no additions; keep quoted material as is.
- Mark translated text in the UI ("Translated from English") with a toggle to show the English original.

### D. Source titles and quotes
- Show as is, in the original language, with a small language tag; never auto-translate `quote` by default (neutrality: the quote is the evidence).
- Optional "translate quote" button on demand, shown as a machine translation next to the original, never replacing it, never cached as authoritative.

## 4. Cost per sheet per language (Haiku, rough)

Not measured; estimates only, to be replaced by real numbers from one sheet.

- Translatable text per sheet: about 20–40 facts × ~40–80 tokens each, plus relation descriptions, plus a few structured strings: **~2k–4k tokens of input and about the same of output**, plus ~500 tokens of instructions (cacheable).
- At Haiku-tier pricing this is on the order of **a fraction of a cent to about one cent per sheet per language**; check the current price list before quoting. Compare: one research run is up to 6 sections × 8 searches, orders of magnitude more.
- Cost is bounded by caching: once per (fact, language), then free. Main risk is not cost but quality and neutrality (below).

## 5. Neutrality risks of translating attributed statements

- Loss of attribution or hedging ("alleged", "indicted", "mis en examen" ≠ "convicted"): a translator may harden or soften. Legal terms have no 1:1 equivalents (mise en examen vs indictment vs charge).
- Presumption of innocence: stage wording must survive translation; the code (`procedural_stage`) is the source of truth, the sentence should be checked against it.
- Tone drift: translated adjectives or idioms add judgement.
- Name and transliteration errors (non-Latin names): use Wikidata labels, never the model.
- Round-trip loss: the translation is a derivative of an LLM output of a source; two LLM layers. Keep the English original and the sources one click away.
- Mitigations:
  - Sensitive sections (convictions, ongoing cases, revelations) are `sensitive: true`: translate only after the English fact is `published` (reviewed), and render legal-stage labels from the dictionary, not from the model.
  - Keep a glossary (legal terms per language) in the prompt; temperature 0.
  - Cheap automatic check: the translation must contain the same numbers, dates and capitalised names as the English statement; otherwise do not cache, fall back to English.
  - Fall back to English whenever translation is missing or fails; never block the page.
  - Disclose "machine translation" in the UI and provide a way to report errors.

## 6. Recommendation: minimal first step for French

1. Do now (no LLM): UI dictionary for enums/section titles/relation types (B) and Wikidata labels in French for entity label + description (A), from the existing `entity_names` / one extra cached fetch. Fall back to English.
2. Do next: store Q-ids in `identity` (or a `(qid, lang)` label cache) so nationalities and occupations show in French.
3. Leave free text (statements, case names, relation descriptions) in **English with a visible "content in English" note** until C2 is built. Do not translate sensitive sections first.
4. Then C2 for `published` facts, lazily, cached per (fact, lang, source_hash), starting with the non-sensitive sections (controversies, political affiliation, notable relations), measure real cost and quality on the golden set (`eval/golden/person.yaml`) with a French reviewer, and only then extend to sensitive sections.
5. Quotes and source titles stay in their original language.

## 7. Questions for the owner

1. Is "content in English, UI in French" acceptable for the first French release?
2. Are machine-translated sensitive sections acceptable at all, or only after human review per language? (Counsel question.)
3. Which languages after French? (Wikidata labels already cover en, fr, de, es, it.)
4. Should the English original always be visible next to the translation?
