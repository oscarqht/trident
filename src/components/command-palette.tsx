'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Repository } from '@/lib/types';
import { useRepositories } from '@/hooks/use-git';
import { cn, getRepositoryDisplayName } from '@/lib/utils';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';

function sortByLastOpenedDesc(a: Repository, b: Repository) {
  return new Date(b.lastOpenedAt || 0).getTime() - new Date(a.lastOpenedAt || 0).getTime();
}

export function CommandPalette() {
  const router = useRouter();
  const { data: repositories } = useRepositories();
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const recentRepositories = useMemo(
    () =>
      (repositories || [])
        .filter((repo) => Boolean(repo.lastOpenedAt))
        .sort(sortByLastOpenedDesc)
        .slice(0, 5),
    [repositories]
  );

  const filteredRepositories = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return recentRepositories;

    return recentRepositories.filter((repo) => {
      const name = getRepositoryDisplayName(repo).toLowerCase();
      const repoPath = repo.path.toLowerCase();
      return name.includes(keyword) || repoPath.includes(keyword);
    });
  }, [query, recentRepositories]);

  const closePalette = useCallback(() => {
    setIsOpen(false);
    setQuery('');
    setSelectedIndex(0);
  }, []);

  const activeIndex =
    filteredRepositories.length === 0
      ? -1
      : Math.min(selectedIndex, filteredRepositories.length - 1);

  const openRepository = useCallback(
    (repoPath: string) => {
      closePalette();
      router.push(`/workspace?path=${encodeURIComponent(repoPath)}`);
    },
    [closePalette, router]
  );

  useEffect(() => {
    const onGlobalKeyDown = (event: KeyboardEvent) => {
      const isCommandOpenShortcut = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k';
      if (isCommandOpenShortcut) {
        event.preventDefault();
        setIsOpen(true);
      }
    };

    window.addEventListener('keydown', onGlobalKeyDown);
    return () => window.removeEventListener('keydown', onGlobalKeyDown);
  }, []);

  useEscapeDismiss(isOpen, closePalette);

  useEffect(() => {
    if (!isOpen) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 px-4 py-16"
      onMouseDown={closePalette}
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
    >
      <div
        className="mx-auto w-full max-w-xl overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="border-b border-base-300 px-3 py-2.5 flex items-center gap-2.5">
          <i className="iconoir-search text-[16px] text-base-content/40 shrink-0 ml-1" aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setSelectedIndex(0);
            }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                if (filteredRepositories.length > 0) {
                  setSelectedIndex((current) => (current + 1) % filteredRepositories.length);
                }
                return;
              }

              if (event.key === 'ArrowUp') {
                event.preventDefault();
                if (filteredRepositories.length > 0) {
                  setSelectedIndex((current) =>
                    current <= 0 ? filteredRepositories.length - 1 : current - 1
                  );
                }
                return;
              }

              if (event.key === 'Enter') {
                event.preventDefault();
                const selectedRepo = activeIndex >= 0 ? filteredRepositories[activeIndex] : null;
                if (selectedRepo) {
                  openRepository(selectedRepo.path);
                }
              }
            }}
            placeholder="Search repositories..."
            className="w-full bg-transparent text-sm focus:outline-none placeholder:text-base-content/40"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              className="text-xs text-base-content/40 hover:text-base-content px-1.5 py-0.5 rounded"
            >
              Clear
            </button>
          )}
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5">
          <div className="px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-base-content/50">
            {query ? 'Matching repositories' : 'Recent repositories'}
          </div>

          {recentRepositories.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-base-content/50">No recently opened repositories yet.</div>
          )}

          {recentRepositories.length > 0 && filteredRepositories.length === 0 && (
            <div className="px-4 py-8 text-center text-xs text-base-content/50">No matching repositories found.</div>
          )}

          {filteredRepositories.map((repo, index) => {
            const repoDisplayName = getRepositoryDisplayName(repo);
            const isSelected = activeIndex === index;
            return (
            <button
              key={repo.path}
              type="button"
              className={cn(
                'flex w-full items-center justify-between gap-3 px-3 py-2 text-left rounded-md transition-colors cursor-pointer',
                isSelected ? 'bg-base-200 text-base-content' : 'hover:bg-base-200/60 text-base-content/80'
              )}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => openRepository(repo.path)}
            >
              <div className="min-w-0 flex items-center gap-2.5">
                <i className="iconoir-folder text-[15px] opacity-60 shrink-0" aria-hidden="true" />
                <div className="min-w-0">
                  <div className="truncate text-xs font-semibold">{repoDisplayName}</div>
                  <div className="truncate text-[11px] opacity-50 font-mono mt-0.5">{repo.path}</div>
                </div>
              </div>
              <span className="text-[11px] opacity-50 shrink-0 font-medium">Open ↵</span>
            </button>
            );
          })}
        </div>

        <div className="border-t border-base-300 px-3.5 py-2 text-[11px] text-base-content/50 flex items-center justify-between bg-base-200/30">
          <span>Navigate with <kbd className="kbd kbd-xs">↑</kbd> <kbd className="kbd kbd-xs">↓</kbd></span>
          <span>Open <kbd className="kbd kbd-xs">Enter</kbd></span>
        </div>
      </div>
    </div>
  );
}
