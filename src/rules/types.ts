export interface SiteRule {
  id: string;
  mainContentSelectors?: string[];
  includeSelectors?: string[];
  excludeSelectors?: string[];
}

export interface RuleCatalogEntry {
  id: string;
  hostnames?: string[];
  hostnameSuffixes?: string[];
  pathPrefixes?: string[];
  excludePathPrefixes?: string[];
  load: () => Promise<SiteRule>;
}
