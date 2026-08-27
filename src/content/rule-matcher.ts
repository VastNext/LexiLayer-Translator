import { ruleCatalog } from '../rules/catalog';
import { generalRule } from '../rules/general';
import type { RuleCatalogEntry, SiteRule } from '../rules/types';

function matchesEntry(url: URL, entry: RuleCatalogEntry): boolean {
  const hostnameMatches = entry.hostnames?.includes(url.hostname)
    || entry.hostnameSuffixes?.some((suffix) => url.hostname.endsWith(suffix));
  if (!hostnameMatches) return false;
  if (entry.pathPrefixes && !entry.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix))) return false;
  return !entry.excludePathPrefixes?.some((prefix) => url.pathname.startsWith(prefix));
}

export async function matchSiteRule(
  url: URL,
  catalog: RuleCatalogEntry[] = ruleCatalog,
  fallback: SiteRule = generalRule,
): Promise<SiteRule> {
  const entry = catalog.find((candidate) => matchesEntry(url, candidate));
  return entry ? entry.load() : fallback;
}
