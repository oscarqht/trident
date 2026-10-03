type QueryParams = URLSearchParams | Record<string, string | null | undefined>;

/** Build a workspace URL: /workspace/<name>[/<subPath>][?params]. */
export function workspaceUrl(name: string, subPath: string = '', params?: QueryParams): string {
  const base = `/workspace/${encodeURIComponent(name)}${subPath}`;
  const search = new URLSearchParams();
  if (params instanceof URLSearchParams) {
    params.forEach((value, key) => search.set(key, value));
  } else if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value) search.set(key, value);
    }
  }
  const query = search.toString();
  return query ? `${base}?${query}` : base;
}
