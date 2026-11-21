// Research caches and the corpus/notes split. Offline and free: the search provider, KwazatBot
// and the Anthropic client are all mocked.
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { entities, eq, openDb, pageCache, researchCorpora, searchCache, sectionRuns, uuidv7, type Db } from "@kwazat/db";
import { cachedFetch, cachedSearch, cacheTtls, normalizeQuery, purgeExpired, type PageFetcher } from "../src/cache.ts";
import { client, resolveConfig } from "../src/claude.ts";
import type { FetchOutcome } from "../src/fetcher.ts";
import { runSection, type Entity, type RunSectionOptions } from "../src/pipeline.ts";
import { gatherHash, loadPlaybook, notesHash, type Playbook, type ResearchSection } from "../src/playbook.ts";
import type { SearchProvider, SearchQuery, SearchResult } from "../src/search/index.ts";
import { loadRegistry } from "../src/sources.ts";

const config = { ...resolveConfig(), searchProvider: "brave" as const };
const registry = loadRegistry(undefined, { generatedAt: "", sources: [], countries: {} });
const FILLER = " Full article text from the publisher.".repeat(20);
const articleOf = (url: string) => `Article body of ${url}.${FILLER}`;

class FakeProvider implements SearchProvider {
  readonly id = "fake";
  readonly costPerQueryUsd = 0.005;
  calls: SearchQuery[] = [];
  async search(query: SearchQuery): Promise<SearchResult[]> {
    this.calls.push(query);
    const n = this.calls.length;
    return [
      { url: `https://www.reuters.com/world/case-${query.q.length}`, title: `Result ${n}`, snippet: "Court ruling snippet", extraSnippets: [], publishedAt: "2026-01-01", siteName: "Reuters" },
      { url: "https://apnews.com/article/appeal", title: "Appeal", snippet: "Appeal snippet", extraSnippets: [], publishedAt: null, siteName: "AP" },
    ];
  }
}

class FakeFetcher implements PageFetcher {
  refused = new Set<string>();
  fetches: string[] = [];
  async policy(url: string) {
    return [...this.refused].some((h) => url.includes(h)) ? "publisher refuses AI processing (test)" : null;
  }
  async fetch(url: string): Promise<FetchOutcome> {
    this.fetches.push(url);
    if (url.includes("broken")) return { url, status: "failed", reason: "HTTP 503", title: null, text: null };
    return { url, status: "fetched", reason: null, title: "Article", text: articleOf(url) };
  }
}

const withDb = async (fn: (db: Db) => Promise<void>) => {
  const db = await openDb({ dataDir: "memory://" });
  try {
    await fn(db);
  } finally {
    await db.close();
  }
};

// --- Search and page caches ------------------------------------------------------------------

test("search results are cached per normalized query and provider params", async () => {
  await withDb(async (db) => {
    const provider = new FakeProvider();
    const opts = { ttlDays: 30 };
    const first = await cachedSearch(db, provider, { q: "Jane Doe  conviction", lang: "EN", count: 10 }, opts);
    const second = await cachedSearch(db, provider, { q: " jane doe conviction ", lang: "en", count: 10 }, opts);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.deepEqual(second.results, first.results);
    assert.equal(provider.calls.length, 1, "the second query hit the cache");

    await cachedSearch(db, provider, { q: "jane doe conviction", lang: "en", count: 20 }, opts);
    assert.equal(provider.calls.length, 2, "another result count is another query");
    await cachedSearch(db, provider, { q: "jane doe conviction", lang: "en", count: 10 }, { ...opts, refresh: true });
    assert.equal(provider.calls.length, 3, "refresh bypasses the cache");
    const later = new Date(Date.now() + 31 * 86_400_000);
    assert.equal((await cachedSearch(db, provider, { q: "jane doe conviction", lang: "en", count: 10 }, { ...opts, now: later })).cached, false);
    assert.deepEqual(normalizeQuery({ q: "  A  b ", country: "fr" }), { q: "a b", lang: undefined, country: "FR", count: undefined });
  });
});

test("pages are cached by normalized URL, never for an opted-out publisher, failures not at all", async () => {
  await withDb(async (db) => {
    const fetcher = new FakeFetcher();
    const opts = { ttlDays: 2 };
    await cachedFetch(db, fetcher, "https://www.example.org/a?utm_source=x", opts);
    const again = await cachedFetch(db, fetcher, "https://example.org/a", opts);
    assert.equal(again.cached, true);
    assert.equal(again.text, articleOf("https://www.example.org/a?utm_source=x"));
    assert.equal(fetcher.fetches.length, 1);

    // The publisher opts out after the page was cached: the cached text is no longer served.
    fetcher.refused.add("example.org");
    const refused = await cachedFetch(db, fetcher, "https://example.org/a", opts);
    assert.equal(refused.status, "snippet_only");
    assert.equal(refused.text, null);
    await cachedFetch(db, fetcher, "https://example.org/b", opts);
    assert.equal((await db.select().from(pageCache).where(eq(pageCache.url, "https://example.org/b"))).length, 0, "opted-out page never stored");

    await cachedFetch(db, fetcher, "https://broken.example.com/x", opts);
    assert.equal((await db.select().from(pageCache).where(eq(pageCache.url, "https://broken.example.com/x"))).length, 0, "transient failure not cached");
  });
});

test("expired cache rows are purged; retention is short with a remote database", async () => {
  await withDb(async (db) => {
    const old = new Date(Date.now() - 10 * 86_400_000);
    await db.insert(pageCache).values({ url: "https://old", status: "fetched", text: "old", fetchedAt: old });
    await db.insert(pageCache).values({ url: "https://new", status: "fetched", text: "new" });
    await db.insert(searchCache).values({ key: "k", provider: "fake", query: {}, results: [], fetchedAt: old });
    await purgeExpired(db, { searchDays: 3, pageDays: 2, corpusDays: 30 });
    assert.deepEqual((await db.select().from(pageCache)).map((r) => r.url), ["https://new"]);
    assert.equal((await db.select().from(searchCache)).length, 0);
  });
  assert.equal(cacheTtls({ DATABASE_URL: "postgres://x" }).pageDays, 2);
  assert.ok(cacheTtls({}).pageDays > 2);
  assert.equal(cacheTtls({ KWAZAT_PAGE_CACHE_DAYS: "1" }).pageDays, 1);
});

// --- Corpus split ----------------------------------------------------------------------------

const playbook = loadPlaybook("person");
const section = playbook.sections.find((s): s is ResearchSection => s.id === "convictions" && s.method === "research")!;
const withSection = (patch: Partial<ResearchSection>): [Playbook, ResearchSection] => {
  const s = { ...section, ...patch };
  return [{ ...playbook, sections: playbook.sections.map((x) => (x.id === s.id ? s : x)) }, s];
};

test("instructions only shape the notes; the search topic shapes the corpus", () => {
  const [pbI, sI] = withSection({ instructions: section.instructions + " Reworded." });
  assert.equal(gatherHash(pbI, sI, config, null), gatherHash(playbook, section, config, null));
  assert.notEqual(notesHash(pbI, sI, config), notesHash(playbook, section, config));

  const [pbT, sT] = withSection({ search_topic: "Something else" });
  assert.notEqual(gatherHash(pbT, sT, config, null), gatherHash(playbook, section, config, null));
  assert.equal(notesHash(pbT, sT, config), notesHash(playbook, section, config));

  // Without search_topic the planner gets the instructions: rewording them gathers again.
  const [pbN, sN] = withSection({ search_topic: undefined });
  const [pbN2, sN2] = withSection({ search_topic: undefined, instructions: section.instructions + " Reworded." });
  assert.notEqual(gatherHash(pbN2, sN2, config, null), gatherHash(pbN, sN, config, null));

  assert.notEqual(notesHash({ ...playbook, style: playbook.style + " More." }, section, config), notesHash(playbook, section, config));
  assert.equal(gatherHash({ ...playbook, style: playbook.style + " More." }, section, config, null), gatherHash(playbook, section, config, null));
});

/** Mocked Anthropic calls, told apart by their system prompt. */
function mockClaude() {
  const calls = { plan: 0, triage: 0, notes: 0, extract: 0, notesPrompts: [] as string[] };
  const reply = (text: string, model = "claude-haiku-5-5") => ({
    id: "msg",
    type: "message",
    role: "assistant",
    model,
    stop_reason: "end_turn",
    content: [{ type: "text", text }],
    usage: { input_tokens: 1000, output_tokens: 100 },
  });
  const m = mock.method(client.beta.messages, "create", async (params: { system: string; messages: { content: string }[] }) => {
    if (params.system.startsWith("You plan web searches")) {
      calls.plan++;
      return reply(JSON.stringify({ queries: [{ q: "jane doe conviction", lang: "en", country: null }, { q: "jane doe appeal", lang: "en", country: null }] }));
    }
    if (params.system.startsWith("You select which search results")) {
      calls.triage++;
      return reply(JSON.stringify({ read: [1, 2] }));
    }
    if (params.system.startsWith("You are a meticulous research assistant")) {
      calls.notes++;
      calls.notesPrompts.push(params.messages[0]!.content);
      return reply("Jane Doe was convicted in 2025. https://reuters.com/world/case-19", "claude-sonnet-5-5");
    }
    calls.extract++;
    return reply(JSON.stringify({ facts: [], relations: [] }));
  });
  return { calls, restore: () => m.mock.restore() };
}

async function newPerson(db: Db): Promise<Entity> {
  const [e] = await db.insert(entities).values({ id: uuidv7(), type: "person", label: "Jane Doe", identity: {} }).returning();
  return e!;
}

test("editing a section re-pays only the layers whose key changed", async () => {
  const { calls, restore } = mockClaude();
  try {
    await withDb(async (db) => {
      const entity = await newPerson(db);
      const provider = new FakeProvider();
      const fetcher = new FakeFetcher();
      const opts: RunSectionOptions = { provider, fetcher, log: () => {} };
      const run = (pb: Playbook, s: ResearchSection, extra: RunSectionOptions = {}) =>
        runSection(db, entity, pb, s, config, registry, { ...opts, ...extra });

      // 1. First run: everything is paid.
      const first = await run(playbook, section);
      assert.equal(first.status, "succeeded", JSON.stringify(first));
      assert.deepEqual([calls.plan, calls.triage, calls.notes, calls.extract, provider.calls.length], [1, 1, 1, 1, 2]);
      assert.ok(calls.notesPrompts[0]!.includes("Article body of https://www.reuters.com/world/case-19"), "notes see the fetched page");
      const [stored] = await db.select().from(researchCorpora);
      assert.ok(!JSON.stringify(stored!.docs).includes("Full article text"), "the corpus holds no page text");
      const [r1] = await db.select().from(sectionRuns);
      const stages = (r1!.usage as { stages: Record<string, unknown> }).stages;
      assert.deepEqual(Object.keys(stages).sort(), ["extraction", "notes", "plan", "search", "triage"]);

      // 2. Up to date: nothing runs.
      assert.equal((await run(playbook, section)).status, "skipped");

      // 3. Instructions reworded: corpus reused, notes and extraction re-run.
      const [pbI, sI] = withSection({ instructions: section.instructions + " Reworded." });
      const second = await run(pbI, sI);
      assert.ok(second.status === "succeeded" && second.corpusReused && !second.notesReused);
      assert.deepEqual([calls.plan, calls.triage, calls.notes, calls.extract, provider.calls.length], [1, 1, 2, 2, 2]);
      assert.equal(fetcher.fetches.length, 2, "page text came from the page cache");

      // 4. Schema changed: corpus and notes reused, extraction only.
      const [pbS, sS] = withSection({ instructions: sI.instructions, item_schema: { ...section.item_schema, extra: true } });
      const third = await run(pbS, sS);
      assert.ok(third.status === "succeeded" && third.corpusReused && third.notesReused);
      assert.deepEqual([calls.plan, calls.notes, calls.extract], [1, 2, 3]);

      // 5. Search topic changed in dev replay: no planner, no search, notes reused.
      const [pbF, sF] = withSection({ ...sS, search_topic: "Convictions, reworded" });
      const frozen = await run(pbF, sF, { frozenCorpus: true });
      assert.ok(frozen.status === "succeeded" && frozen.corpusReused && frozen.notesReused);
      assert.deepEqual([calls.plan, provider.calls.length, calls.notes], [1, 2, 2]);

      // 6. Same change without replay: the corpus is gathered again, but the planner's queries
      //    hit the search cache and the pages the page cache.
      const regathered = await run(pbF, sF, { force: true }); // step 5 left the section up to date
      assert.ok(regathered.status === "succeeded" && !regathered.corpusReused);
      assert.deepEqual([calls.plan, calls.triage, provider.calls.length, fetcher.fetches.length], [2, 2, 2, 2]);
      assert.equal(regathered.usage.webSearches, 0, "cached searches are not billed");

      // 7. --refresh-corpus bypasses both caches.
      await run(pbF, sF, { refreshCorpus: true });
      assert.deepEqual([provider.calls.length, fetcher.fetches.length], [4, 4]);

      // 8. The publisher opts out: a replay no longer gives its page text to the model.
      fetcher.refused.add("reuters.com");
      await run(pbF, sF, { frozenCorpus: true, force: true });
      const last = calls.notesPrompts.at(-1)!;
      assert.ok(!last.includes("Article body of https://www.reuters.com"), "no cached text of an opted-out publisher");
      assert.ok(last.includes("Article body of https://apnews.com"), "other publishers still read in full");
    });
  } finally {
    restore();
  }
});

test("a frozen corpus never gathers: a section without one fails instead of paying", async () => {
  const { calls, restore } = mockClaude();
  try {
    await withDb(async (db) => {
      const entity = await newPerson(db);
      const provider = new FakeProvider();
      const outcome = await runSection(db, entity, playbook, section, config, registry, {
        provider,
        fetcher: new FakeFetcher(),
        frozenCorpus: true,
        log: () => {},
      });
      assert.equal(outcome.status, "failed");
      assert.match(outcome.status === "failed" ? outcome.error : "", /no stored corpus/);
      assert.deepEqual([calls.plan, calls.notes, provider.calls.length], [0, 0, 0]);
    });
  } finally {
    restore();
  }
});
