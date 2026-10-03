// Repository names are used as the URL slug (/workspace/<name>), so they must be
// URL-safe and unique (case-insensitively) within the per-machine registry.

const VALID_NAME = /^[A-Za-z0-9._-]+$/;

export class RepoNameError extends Error {}

export function isValidRepoName(name: string): boolean {
  return VALID_NAME.test(name) && !/^\.+$/.test(name);
}

/** Turn an arbitrary folder name into a valid, lowercased repo name. */
export function slugifyRepoName(raw: string): string {
  const slug = raw.trim().replace(/[^A-Za-z0-9._-]+/g, '-').toLowerCase();
  return /^\.*$/.test(slug) ? 'repo' : slug;
}

export function repoNamesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Return `base`, or `base-2`, `base-3`, ... so it does not collide with `taken`. */
export function uniqueRepoName(base: string, taken: Iterable<string>): string {
  const lowered = new Set(Array.from(taken, (name) => name.toLowerCase()));
  let candidate = base;
  for (let i = 2; lowered.has(candidate.toLowerCase()); i++) {
    candidate = `${base}-${i}`;
  }
  return candidate;
}

/** Throws RepoNameError unless `name` is valid and not used by another repo. */
export function assertRepoNameAvailable(name: string, taken: Iterable<string>): void {
  if (!isValidRepoName(name)) {
    throw new RepoNameError('Name may only contain letters, numbers, ".", "_" and "-"');
  }
  for (const other of taken) {
    if (repoNamesEqual(other, name)) {
      throw new RepoNameError(`A project named "${name}" already exists`);
    }
  }
}

/**
 * Make every name valid and unique, keeping earlier entries stable.
 * Returns null when nothing needs to change.
 */
export function migrateRepoNames<T extends { name: string; path: string }>(repos: T[]): T[] | null {
  const taken: string[] = [];
  let changed = false;
  const result = repos.map((repo) => {
    const base = isValidRepoName(repo.name ?? '') ? repo.name : slugifyRepoName(repo.name || repo.path.split(/[\\/]/).filter(Boolean).pop() || '');
    const name = uniqueRepoName(base, taken);
    taken.push(name);
    if (name === repo.name) return repo;
    changed = true;
    return { ...repo, name };
  });
  return changed ? result : null;
}
