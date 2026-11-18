import { BraveContext, BraveSearch } from "./brave.ts";
import type { SearchProvider } from "./types.ts";

export type { SearchProvider, SearchQuery, SearchResult } from "./types.ts";

/**
 * Search providers. "anthropic" is special: it is not a SearchProvider but the previous
 * pipeline where Claude's server-side web tools search and read pages themselves.
 * To add a provider (Kagi, a paid Brave plan, ...), implement SearchProvider and register it here.
 */
export const SEARCH_PROVIDERS = ["brave", "brave-context", "anthropic"] as const;
export type SearchProviderId = (typeof SEARCH_PROVIDERS)[number];

export function createSearchProvider(id: Exclude<SearchProviderId, "anthropic">): SearchProvider {
  switch (id) {
    case "brave":
      return new BraveSearch();
    case "brave-context":
      return new BraveContext();
  }
}
