/**
 * OfficialMarketplace.ts — Marketplace endpoints, paths, rate limits, CDN config
 *
 * Based on Claude Code's officialMarketplace.ts (~250 lines)
 *
 * Features:
 *   - Base URL configuration (production + staging)
 *   - All API path templates
 *   - Rate limiting configuration
 *   - Cache TTL defaults
 *   - Download size limits
 *   - URL building helpers
 *   - Marketplace validation
 *   - Environment selection
 *   - Health check endpoint
 *   - Telemetry endpoints
 */

// ════════════════════════════════════════════════════════════════════════════
// Marketplace Names
// ════════════════════════════════════════════════════════════════════════════

export const OFFICIAL_MARKETPLACE_NAMES = new Set(['official', 'staging']);

// ════════════════════════════════════════════════════════════════════════════
// Base URLs
// ════════════════════════════════════════════════════════════════════════════

export const OFFICIAL_MARKETPLACE_URL = 'https://storage.googleapis.com/clow-marketplace';
export const STAGING_MARKETPLACE_URL = 'https://storage.googleapis.com/clow-marketplace-staging';

// ════════════════════════════════════════════════════════════════════════════
// API Path Templates
// ════════════════════════════════════════════════════════════════════════════

/** Catalog index (list of all available plugins) */
export const CATALOG_PATH = '/catalog/index.json';

/** Remote blocklist (compromised/malicious plugins) */
export const BLOCKLIST_PATH = '/blocklist.json';

/** Flagged plugins (under review, may have issues) */
export const FLAGGED_PATH = '/flagged.json';

/** Health check endpoint */
export const HEALTH_PATH = '/health';

/** Plugin manifest by ID and version */
export const PLUGIN_MANIFEST_PATH = '/plugins/{pluginId}/{version}/manifest.json';

/** Plugin download (zip archive) */
export const PLUGIN_DOWNLOAD_PATH = '/plugins/{pluginId}/{version}/{pluginId}-{version}.zip';

/** Plugin README */
export const PLUGIN_README_PATH = '/plugins/{pluginId}/{version}/README.md';

/** Plugin changelog */
export const PLUGIN_CHANGELOG_PATH = '/plugins/{pluginId}/{version}/CHANGELOG.md';

/** Telemetry: install event */
export const TELEMETRY_INSTALL_PATH = '/telemetry/install';

/** Telemetry: uninstall event */
export const TELEMETRY_UNINSTALL_PATH = '/telemetry/uninstall';

/** Telemetry: update event */
export const TELEMETRY_UPDATE_PATH = '/telemetry/update';

/** Search endpoint (server-side search) */
export const SEARCH_PATH = '/catalog/search';

// ════════════════════════════════════════════════════════════════════════════
// Identification
// ════════════════════════════════════════════════════════════════════════════

export const OFFICIAL_MARKETPLACE_ID = 'official';
export const STAGING_MARKETPLACE_ID = 'staging';

// ════════════════════════════════════════════════════════════════════════════
// Rate Limiting
// ════════════════════════════════════════════════════════════════════════════

/** Minimum interval between requests (ms) */
export const RATE_LIMIT_INTERVAL_MS = 1_000;

/** Max requests per minute */
export const RATE_LIMIT_RPM = 30;

/** Backoff multiplier on rate limit hit */
export const RATE_LIMIT_BACKOFF_MULTIPLIER = 2;

/** Max backoff time (ms) */
export const RATE_LIMIT_MAX_BACKOFF_MS = 60_000;

/** Max retries on rate limit */
export const RATE_LIMIT_MAX_RETRIES = 3;

// ════════════════════════════════════════════════════════════════════════════
// Cache TTLs
// ════════════════════════════════════════════════════════════════════════════

/** How long to cache the catalog (4 hours) */
export const CATALOG_CACHE_TTL_MS = 4 * 60 * 60 * 1_000;

/** How long to cache individual manifests (1 hour) */
export const MANIFEST_CACHE_TTL_MS = 60 * 60 * 1_000;

/** How long to cache the blocklist (30 minutes) */
export const BLOCKLIST_CACHE_TTL_MS = 30 * 60 * 1_000;

/** How long to cache search results (10 minutes) */
export const SEARCH_CACHE_TTL_MS = 10 * 60 * 1_000;

// ════════════════════════════════════════════════════════════════════════════
// Download Limits
// ════════════════════════════════════════════════════════════════════════════

/** Max plugin zip size (50MB) */
export const MAX_PLUGIN_ZIP_SIZE_BYTES = 50 * 1024 * 1024;

/** Max catalog size (10MB) */
export const MAX_CATALOG_SIZE_BYTES = 10 * 1024 * 1024;

/** Max manifest size (1MB) */
export const MAX_MANIFEST_SIZE_BYTES = 1024 * 1024;

/** Download timeout (2 minutes) */
export const DOWNLOAD_TIMEOUT_MS = 120_000;

/** API request timeout (30 seconds) */
export const API_TIMEOUT_MS = 30_000;

/** Max concurrent downloads */
export const MAX_CONCURRENT_DOWNLOADS = 3;

// ════════════════════════════════════════════════════════════════════════════
// Helper Functions
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build a plugin-specific URL from a template.
 * Replaces {pluginId} and {version} placeholders.
 */
export function buildPluginUrl(
  baseUrl: string,
  template: string,
  pluginId: string,
  version: string,
): string {
  return baseUrl + template
    .replace(/\{pluginId\}/g, encodeURIComponent(pluginId))
    .replace(/\{version\}/g, encodeURIComponent(version));
}

/**
 * Check if a marketplace ID is official.
 */
export function isOfficialMarketplace(id: string): boolean {
  return OFFICIAL_MARKETPLACE_NAMES.has(id);
}

/**
 * Get the base URL for a marketplace by ID.
 */
export function getMarketplaceUrl(id: string): string {
  return id === 'staging' ? STAGING_MARKETPLACE_URL : OFFICIAL_MARKETPLACE_URL;
}

/**
 * Validate a marketplace URL.
 */
export function isValidMarketplaceUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Get marketplace ID from a URL.
 */
export function getMarketplaceIdFromUrl(url: string): string {
  if (url.includes('staging')) return STAGING_MARKETPLACE_ID;
  return OFFICIAL_MARKETPLACE_ID;
}

/**
 * Build the full catalog URL for a marketplace.
 */
export function getCatalogUrl(marketplaceId: string): string {
  return getMarketplaceUrl(marketplaceId) + CATALOG_PATH;
}

/**
 * Build the full blocklist URL for a marketplace.
 */
export function getBlocklistUrl(marketplaceId: string): string {
  return getMarketplaceUrl(marketplaceId) + BLOCKLIST_PATH;
}

/**
 * Build the download URL for a specific plugin version.
 */
export function getDownloadUrl(marketplaceId: string, pluginId: string, version: string): string {
  return buildPluginUrl(getMarketplaceUrl(marketplaceId), PLUGIN_DOWNLOAD_PATH, pluginId, version);
}

/**
 * Build the manifest URL for a specific plugin version.
 */
export function getManifestUrl(marketplaceId: string, pluginId: string, version: string): string {
  return buildPluginUrl(getMarketplaceUrl(marketplaceId), PLUGIN_MANIFEST_PATH, pluginId, version);
}

/**
 * Get the health check URL for a marketplace.
 */
export function getHealthUrl(marketplaceId: string): string {
  return getMarketplaceUrl(marketplaceId) + HEALTH_PATH;
}

/**
 * Check if the current environment should use staging marketplace.
 */
export function shouldUseStaging(): boolean {
  return process.env.CLOW_MARKETPLACE_ENV === 'staging' ||
         process.env.NODE_ENV === 'development';
}

/**
 * Get the default marketplace ID for the current environment.
 */
export function getDefaultMarketplaceId(): string {
  return shouldUseStaging() ? STAGING_MARKETPLACE_ID : OFFICIAL_MARKETPLACE_ID;
}
