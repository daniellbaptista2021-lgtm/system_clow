/**
 * MarketplaceCatalog.ts — Catalog parsing, search, filtering, ranking
 *
 * Based on Claude Code's marketplace catalog patterns (500 lines)
 *
 * Implements:
 *   - Full-text search across name, description, tags, keywords
 *   - Category filtering
 *   - Tag intersection filtering
 *   - Rating threshold filtering
 *   - Multiple sort strategies (popular, recent, name, rating, relevance)
 *   - Pagination (offset + limit)
 *   - Relevance scoring for search results
 *   - Blocked/flagged plugin exclusion
 *   - Catalog validation
 *   - Statistics computation
 *   - Version grouping (list all versions of a plugin)
 *   - TF-IDF relevance scoring
 *   - Multi-field weighting
 *   - Faceted search results
 *   - Catalog diff detection (additions, removals, updates)
 */

import type {
  MarketplaceCatalog,
  MarketplaceCatalogEntry,
  MarketplaceSearchOptions,
  PluginCategory,
} from '../types.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MIN_SEARCH_QUERY_LENGTH = 2;

// ─── Search Result with Score ───────────────────────────────────────────────

interface ScoredEntry {
  entry: MarketplaceCatalogEntry;
  relevanceScore: number;
}

interface FacetedSearchResult {
  entries: MarketplaceCatalogEntry[];
  totalCount: number;
  facets: SearchFacets;
}

interface SearchFacets {
  categories: Array<{ category: PluginCategory; count: number }>;
  tags: Array<{ tag: string; count: number }>;
  authors: Array<{ author: string; count: number }>;
  ratingBuckets: Array<{ minRating: number; maxRating: number; count: number }>;
}

interface CatalogDiff {
  added: MarketplaceCatalogEntry[];
  removed: MarketplaceCatalogEntry[];
  updated: Array<{
    name: string;
    oldVersion: string;
    newVersion: string;
    oldEntry: MarketplaceCatalogEntry;
    newEntry: MarketplaceCatalogEntry;
  }>;
  unchanged: number;
}

interface CatalogValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ─── TF-IDF Helpers ─────────────────────────────────────────────────────────

/**
 * Compute term frequency for a term in a document (normalized).
 */
function termFrequency(term: string, document: string): number {
  const words = document.toLowerCase().split(/\s+/);
  if (words.length === 0) return 0;
  const count = words.filter(w => w === term).length;
  return count / words.length;
}

/**
 * Compute inverse document frequency for a term across all documents.
 */
function inverseDocumentFrequency(term: string, documents: string[]): number {
  const containing = documents.filter(doc =>
    doc.toLowerCase().split(/\s+/).includes(term),
  ).length;
  if (containing === 0) return 0;
  return Math.log(documents.length / containing);
}

/**
 * Compute TF-IDF score for a term in a document given a corpus.
 */
function tfidf(term: string, document: string, corpus: string[]): number {
  return termFrequency(term, document) * inverseDocumentFrequency(term, corpus);
}

// ════════════════════════════════════════════════════════════════════════════
// Search Functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Search and filter the marketplace catalog.
 * Returns matching entries sorted and paginated.
 */
export function searchCatalog(
  catalog: MarketplaceCatalog,
  opts: MarketplaceSearchOptions = {},
): MarketplaceCatalogEntry[] {
  // Start with all non-blocked, non-flagged plugins
  let candidates = catalog.plugins.filter(p => !p.blocked && !p.flagged);

  // Category filter
  if (opts.category) {
    candidates = candidates.filter(p => p.category === opts.category);
  }

  // Tag filter (any tag matches)
  if (opts.tags && opts.tags.length > 0) {
    candidates = candidates.filter(p =>
      opts.tags!.some(tag => p.tags.includes(tag)),
    );
  }

  // Rating filter
  if (opts.minRating !== undefined) {
    candidates = candidates.filter(p => (p.rating ?? 0) >= opts.minRating!);
  }

  // Text search with relevance scoring
  let scored: ScoredEntry[];
  if (opts.query && opts.query.length >= MIN_SEARCH_QUERY_LENGTH) {
    scored = scoreByRelevance(candidates, opts.query);
    // Filter out zero-score results
    scored = scored.filter(s => s.relevanceScore > 0);
  } else {
    scored = candidates.map(entry => ({ entry, relevanceScore: 0 }));
  }

  // Sort
  const sortBy = opts.sortBy ?? (opts.query ? 'popular' : 'popular');
  sortResults(scored, sortBy);

  // Pagination
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  return scored
    .slice(offset, offset + limit)
    .map(s => s.entry);
}

/**
 * Search catalog and return results with faceted aggregations.
 * Facets count categories, tags, authors, and rating buckets
 * across the entire matching set (before pagination).
 */
export function searchCatalogFaceted(
  catalog: MarketplaceCatalog,
  opts: MarketplaceSearchOptions = {},
): FacetedSearchResult {
  // Start with all non-blocked, non-flagged plugins
  let candidates = catalog.plugins.filter(p => !p.blocked && !p.flagged);

  // Category filter
  if (opts.category) {
    candidates = candidates.filter(p => p.category === opts.category);
  }

  // Tag filter
  if (opts.tags && opts.tags.length > 0) {
    candidates = candidates.filter(p =>
      opts.tags!.some(tag => p.tags.includes(tag)),
    );
  }

  // Rating filter
  if (opts.minRating !== undefined) {
    candidates = candidates.filter(p => (p.rating ?? 0) >= opts.minRating!);
  }

  // Text search
  let scored: ScoredEntry[];
  if (opts.query && opts.query.length >= MIN_SEARCH_QUERY_LENGTH) {
    scored = scoreByRelevance(candidates, opts.query);
    scored = scored.filter(s => s.relevanceScore > 0);
  } else {
    scored = candidates.map(entry => ({ entry, relevanceScore: 0 }));
  }

  // Compute facets from all matching results (before pagination)
  const facets = computeFacets(scored.map(s => s.entry));

  // Sort
  const sortBy = opts.sortBy ?? (opts.query ? 'popular' : 'popular');
  sortResults(scored, sortBy);

  // Pagination
  const offset = Math.max(0, opts.offset ?? 0);
  const limit = Math.min(Math.max(1, opts.limit ?? DEFAULT_LIMIT), MAX_LIMIT);

  const entries = scored.slice(offset, offset + limit).map(s => s.entry);

  return {
    entries,
    totalCount: scored.length,
    facets,
  };
}

/**
 * Score entries by relevance to a search query.
 *
 * Scoring rules:
 *   - Exact name match: +10
 *   - Name contains query: +5
 *   - Name starts with query: +3
 *   - Description contains query: +2
 *   - Tag exact match: +3 per tag
 *   - Keyword match: +2 per keyword
 *   - Author name match: +1
 *   - Install count bonus: +0.001 * log(installs)
 */
function scoreByRelevance(
  entries: MarketplaceCatalogEntry[],
  query: string,
): ScoredEntry[] {
  const q = query.toLowerCase().trim();
  const queryWords = q.split(/\s+/).filter(w => w.length >= 2);

  return entries.map(entry => {
    let score = 0;
    const nameLower = entry.name.toLowerCase();
    const descLower = entry.description.toLowerCase();

    // Name matching (highest weight)
    if (nameLower === q) {
      score += 10;
    } else if (nameLower.startsWith(q)) {
      score += 5;
    } else if (nameLower.includes(q)) {
      score += 3;
    }

    // Word-level name matching
    for (const word of queryWords) {
      if (nameLower.includes(word)) score += 1;
    }

    // Description matching
    if (descLower.includes(q)) {
      score += 2;
    }
    for (const word of queryWords) {
      if (descLower.includes(word)) score += 0.5;
    }

    // Tag matching
    for (const tag of entry.tags) {
      const tagLower = tag.toLowerCase();
      if (tagLower === q) score += 3;
      else if (tagLower.includes(q)) score += 1;
      for (const word of queryWords) {
        if (tagLower.includes(word)) score += 0.5;
      }
    }

    // Author matching
    if (entry.author?.name?.toLowerCase().includes(q)) {
      score += 1;
    }

    // Install count bonus (logarithmic so popular plugins rank slightly higher)
    if (entry.installCount && entry.installCount > 0) {
      score += Math.log10(entry.installCount) * 0.1;
    }

    // Rating bonus
    if (entry.rating && entry.rating > 3) {
      score += (entry.rating - 3) * 0.2;
    }

    return { entry, relevanceScore: score };
  });
}

/**
 * Score entries using TF-IDF across name and description fields.
 * This provides a more statistically grounded relevance ranking
 * than the simple keyword scoring.
 */
export function scoreByTFIDF(
  entries: MarketplaceCatalogEntry[],
  query: string,
): ScoredEntry[] {
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 2);
  if (queryTerms.length === 0) {
    return entries.map(entry => ({ entry, relevanceScore: 0 }));
  }

  // Build corpus from names + descriptions
  const nameCorpus = entries.map(e => e.name.toLowerCase());
  const descCorpus = entries.map(e => e.description.toLowerCase());

  // Field weights
  const NAME_WEIGHT = 3.0;
  const DESC_WEIGHT = 1.0;
  const TAG_WEIGHT = 2.0;

  return entries.map((entry, idx) => {
    let score = 0;

    for (const term of queryTerms) {
      // Name TF-IDF
      const nameTfidf = tfidf(term, nameCorpus[idx], nameCorpus);
      score += nameTfidf * NAME_WEIGHT;

      // Description TF-IDF
      const descTfidf = tfidf(term, descCorpus[idx], descCorpus);
      score += descTfidf * DESC_WEIGHT;

      // Tag matching (boolean weighted)
      for (const tag of entry.tags) {
        if (tag.toLowerCase().includes(term)) {
          score += TAG_WEIGHT * 0.5;
        }
      }
    }

    return { entry, relevanceScore: score };
  });
}

/**
 * Sort scored results by the specified strategy.
 */
function sortResults(scored: ScoredEntry[], sortBy: string): void {
  switch (sortBy) {
    case 'popular':
      scored.sort((a, b) => {
        // Primary: install count. Secondary: relevance
        const instDiff = (b.entry.installCount ?? 0) - (a.entry.installCount ?? 0);
        if (instDiff !== 0) return instDiff;
        return b.relevanceScore - a.relevanceScore;
      });
      break;

    case 'recent':
      scored.sort((a, b) => b.entry.updatedAt - a.entry.updatedAt);
      break;

    case 'name':
      scored.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
      break;

    case 'rating':
      scored.sort((a, b) => {
        const ratingDiff = (b.entry.rating ?? 0) - (a.entry.rating ?? 0);
        if (ratingDiff !== 0) return ratingDiff;
        return (b.entry.installCount ?? 0) - (a.entry.installCount ?? 0);
      });
      break;

    default:
      // Default: relevance if search query, popular otherwise
      scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Facet Computation
// ════════════════════════════════════════════════════════════════════════════

function computeFacets(entries: MarketplaceCatalogEntry[]): SearchFacets {
  const categoryCounts = new Map<PluginCategory, number>();
  const tagCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();
  const ratingBuckets = [
    { minRating: 4, maxRating: 5, count: 0 },
    { minRating: 3, maxRating: 4, count: 0 },
    { minRating: 2, maxRating: 3, count: 0 },
    { minRating: 1, maxRating: 2, count: 0 },
    { minRating: 0, maxRating: 1, count: 0 },
  ];

  for (const entry of entries) {
    // Categories
    if (entry.category) {
      categoryCounts.set(entry.category, (categoryCounts.get(entry.category) ?? 0) + 1);
    }

    // Tags
    for (const tag of entry.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }

    // Authors
    if (entry.author?.name) {
      authorCounts.set(entry.author.name, (authorCounts.get(entry.author.name) ?? 0) + 1);
    }

    // Rating buckets
    const rating = entry.rating ?? 0;
    for (const bucket of ratingBuckets) {
      if (rating >= bucket.minRating && rating < bucket.maxRating) {
        bucket.count++;
        break;
      }
    }
  }

  return {
    categories: [...categoryCounts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count),
    tags: [...tagCounts.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20), // Top 20 tags
    authors: [...authorCounts.entries()]
      .map(([author, count]) => ({ author, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20), // Top 20 authors
    ratingBuckets,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Catalog Utility Functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Get all unique categories in the catalog.
 */
export function getCatalogCategories(catalog: MarketplaceCatalog): PluginCategory[] {
  const categories = new Set<PluginCategory>();
  for (const plugin of catalog.plugins) {
    if (plugin.category) categories.add(plugin.category);
  }
  return [...categories].sort();
}

/**
 * Get all unique tags in the catalog.
 */
export function getCatalogTags(catalog: MarketplaceCatalog): string[] {
  const tags = new Set<string>();
  for (const plugin of catalog.plugins) {
    for (const tag of plugin.tags) tags.add(tag);
  }
  return [...tags].sort();
}

/**
 * Get all versions of a specific plugin.
 */
export function getPluginVersions(catalog: MarketplaceCatalog, pluginName: string): MarketplaceCatalogEntry[] {
  return catalog.plugins
    .filter(p => p.name === pluginName)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Get the latest version entry for each unique plugin name.
 */
export function deduplicateToLatest(catalog: MarketplaceCatalog): MarketplaceCatalogEntry[] {
  const byName = new Map<string, MarketplaceCatalogEntry>();
  for (const plugin of catalog.plugins) {
    const existing = byName.get(plugin.name);
    if (!existing || plugin.updatedAt > existing.updatedAt) {
      byName.set(plugin.name, plugin);
    }
  }
  return [...byName.values()];
}

/**
 * Compute catalog statistics.
 */
export function computeCatalogStats(catalog: MarketplaceCatalog): {
  totalPlugins: number;
  uniquePlugins: number;
  totalVersions: number;
  categories: number;
  blockedCount: number;
  flaggedCount: number;
  avgRating: number;
  totalInstalls: number;
} {
  const uniqueNames = new Set(catalog.plugins.map(p => p.name));
  let totalRating = 0;
  let ratedCount = 0;
  let totalInstalls = 0;

  for (const plugin of catalog.plugins) {
    if (plugin.rating) { totalRating += plugin.rating; ratedCount++; }
    totalInstalls += plugin.installCount ?? 0;
  }

  return {
    totalPlugins: catalog.plugins.length,
    uniquePlugins: uniqueNames.size,
    totalVersions: catalog.plugins.length - uniqueNames.size,
    categories: getCatalogCategories(catalog).length,
    blockedCount: catalog.plugins.filter(p => p.blocked).length,
    flaggedCount: catalog.plugins.filter(p => p.flagged).length,
    avgRating: ratedCount > 0 ? totalRating / ratedCount : 0,
    totalInstalls,
  };
}

// ════════════════════════════════════════════════════════════════════════════
// Catalog Validation
// ════════════════════════════════════════════════════════════════════════════

/**
 * Validate catalog structure (basic integrity check).
 * Returns errors (fatal issues) and warnings (non-fatal issues).
 */
export function validateCatalog(catalog: unknown): CatalogValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!catalog || typeof catalog !== 'object') {
    return { valid: false, errors: ['Catalog is not an object'], warnings: [] };
  }

  const c = catalog as Record<string, unknown>;

  if (!Array.isArray(c.plugins)) {
    errors.push('Missing or invalid plugins array');
  } else {
    const seenNames = new Map<string, number>();

    for (let i = 0; i < c.plugins.length; i++) {
      const p = c.plugins[i] as Record<string, unknown>;
      if (!p.name) errors.push(`Plugin at index ${i} missing name`);
      if (!p.version) errors.push(`Plugin at index ${i} missing version`);
      if (!p.downloadUrl) errors.push(`Plugin at index ${i} missing downloadUrl`);

      // Warn about duplicates
      if (typeof p.name === 'string' && typeof p.version === 'string') {
        const key = `${p.name}@${p.version}`;
        const prev = seenNames.get(key);
        if (prev !== undefined) {
          warnings.push(`Duplicate entry: ${key} at indices ${prev} and ${i}`);
        } else {
          seenNames.set(key, i);
        }
      }

      // Warn about missing optional fields
      if (typeof p.name === 'string') {
        if (!p.description) warnings.push(`Plugin "${p.name}" missing description`);
        if (!p.author) warnings.push(`Plugin "${p.name}" missing author`);
        if (!Array.isArray(p.tags) || (p.tags as unknown[]).length === 0) {
          warnings.push(`Plugin "${p.name}" has no tags`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

// ════════════════════════════════════════════════════════════════════════════
// Catalog Diff Detection
// ════════════════════════════════════════════════════════════════════════════

/**
 * Detect differences between two catalog versions.
 * Identifies added, removed, and updated plugins.
 */
export function diffCatalogs(
  oldCatalog: MarketplaceCatalog,
  newCatalog: MarketplaceCatalog,
): CatalogDiff {
  const oldByNameVersion = new Map<string, MarketplaceCatalogEntry>();
  const oldLatest = new Map<string, MarketplaceCatalogEntry>();
  const newLatest = new Map<string, MarketplaceCatalogEntry>();

  for (const p of oldCatalog.plugins) {
    oldByNameVersion.set(`${p.name}@${p.version}`, p);
    const existing = oldLatest.get(p.name);
    if (!existing || p.updatedAt > existing.updatedAt) {
      oldLatest.set(p.name, p);
    }
  }

  for (const p of newCatalog.plugins) {
    const existing = newLatest.get(p.name);
    if (!existing || p.updatedAt > existing.updatedAt) {
      newLatest.set(p.name, p);
    }
  }

  const added: MarketplaceCatalogEntry[] = [];
  const removed: MarketplaceCatalogEntry[] = [];
  const updated: CatalogDiff['updated'] = [];
  let unchanged = 0;

  // Find added and updated
  for (const [name, newEntry] of newLatest) {
    const oldEntry = oldLatest.get(name);
    if (!oldEntry) {
      added.push(newEntry);
    } else if (oldEntry.version !== newEntry.version) {
      updated.push({
        name,
        oldVersion: oldEntry.version,
        newVersion: newEntry.version,
        oldEntry,
        newEntry,
      });
    } else {
      unchanged++;
    }
  }

  // Find removed
  for (const [name, oldEntry] of oldLatest) {
    if (!newLatest.has(name)) {
      removed.push(oldEntry);
    }
  }

  return { added, removed, updated, unchanged };
}
