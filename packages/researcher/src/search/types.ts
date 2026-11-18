/**
 * Web search providers. Each one turns a query into a list of results (URL, title, snippet).
 * The research pipeline only depends on this interface, so switching provider (alpha: Brave
 * with its monthly credit; later: a paid plan or another API) is a configuration change.
 */

export type SearchQuery = {
  q: string;
  /** ISO 639-1 language of the query, e.g. "fr". */
  lang?: string;
  /** ISO 3166-1 alpha-2 country to favour, e.g. "FR". */
  country?: string;
  count?: number;
};

export type SearchResult = {
  url: string;
  title: string;
  /** Short excerpt from the search engine (licensed for AI use by the provider). */
  snippet: string;
  /** Additional excerpts when the provider returns several. */
  extraSnippets: string[];
  /** Publication date if the provider knows it (ISO date or free text). */
  publishedAt: string | null;
  /** Site name as given by the provider. */
  siteName: string | null;
};

export interface SearchProvider {
  readonly id: string;
  /** Approximate cost of one query in USD, for cost reports. */
  readonly costPerQueryUsd: number;
  search(query: SearchQuery): Promise<SearchResult[]>;
}
