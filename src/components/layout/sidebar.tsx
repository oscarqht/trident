'use client';

import { cn, getRepoFolderName, getRepositoryDisplayName } from '@/lib/utils';
import Link from 'next/link';
import Image from 'next/image';
import { HomeSettingsModal } from '@/components/home-settings-modal';
import { ThemeToggle } from '@/components/theme-toggle';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { useCurrentRepo, useGitStatus, useUpdateSettings } from '@/hooks/use-git';
import { workspaceUrl } from '@/lib/workspace-url';

const SIDEBAR_COLLAPSED_KEY = 'workspace-sidebar-collapsed';
const SIDEBAR_WIDTH_EXPANDED = 240;
const SIDEBAR_WIDTH_COLLAPSED = 60;

type SidebarProps = React.HTMLAttributes<HTMLDivElement>;
type SidebarPropsWithInitialState = SidebarProps & {
  initialCollapsed?: boolean;
};

export function Sidebar({ className, initialCollapsed = false }: SidebarPropsWithInitialState) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { name: routeName, repo: repository } = useCurrentRepo();
  const repoPath = repository?.path ?? '';
  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const [enableTransition, setEnableTransition] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const updateSettings = useUpdateSettings();
  
  // Fetch git status to get uncommitted changes count
  const { data: gitStatus } = useGitStatus(repoPath || null);
  const conflictsCount = gitStatus?.conflicted?.length ?? 0;
  const currentBranch = gitStatus?.current?.trim();
  const repoDisplayName = repository
    ? getRepositoryDisplayName(repository)
    : (repoPath ? getRepoFolderName(repoPath) : '');

  // Enable transitions only after initial paint to avoid first-load animation.
  useEffect(() => {
    let frame2: number | null = null;
    const frame1 = requestAnimationFrame(() => {
      frame2 = requestAnimationFrame(() => {
        setEnableTransition(true);
      });
    });

    return () => {
      cancelAnimationFrame(frame1);
      if (frame2 !== null) {
        cancelAnimationFrame(frame2);
      }
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(isCollapsed));
  }, [isCollapsed]);

  // Save collapsed state to global settings and localStorage
  const toggleCollapsed = useCallback(() => {
    const newValue = !isCollapsed;
    setIsCollapsed(newValue);
    updateSettings.mutate({ sidebarCollapsed: newValue });
  }, [isCollapsed, updateSettings]);

  const getHref = (subPath: string = '') => {
    const p = new URLSearchParams(searchParams.toString());
    p.delete('tab');
    if (repoPath && currentBranch && currentBranch !== 'HEAD') {
      p.set('branch', currentBranch);
    } else {
      p.delete('branch');
    }
    return workspaceUrl(repository?.name ?? routeName ?? '', subPath, p);
  };

  // The sub-page is whatever follows /workspace/<name>.
  const activeView = pathname.split('/')[3] ?? '';

  const isActive = (view: 'history' | 'conflicts' | 'custom-scripts' | 'settings' | 'stashes') => {
    if (view === 'history') return activeView === '' || activeView === 'history' || activeView === 'changes';
    return activeView === view;
  };

  const sidebarWidth = isCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  return (
    <div 
      style={{ width: sidebarWidth }}
      className={cn(
        "border-r border-base-300 min-h-screen bg-base-200/30 flex flex-col justify-between relative select-none",
        enableTransition && "transition-[width] duration-200 ease-in-out",
        className
      )}
    >
      {/* Top Section */}
      <div className="flex flex-col flex-1 min-h-0">
        {/* Workspace Brand / Header */}
        <div className={cn(
          "h-12 border-b border-base-300 flex items-center shrink-0",
          isCollapsed ? "justify-center px-1" : "justify-between px-3"
        )}>
          {!isCollapsed ? (
            <>
              <Link
                href="/"
                className="flex items-center gap-2.5 min-w-0 hover:opacity-80 transition-opacity"
                title={repoDisplayName ? `${repoDisplayName} - Go to Repositories` : "Go to Repositories"}
              >
                {repository?.icon ? (
                  <span className="text-base leading-none shrink-0" aria-hidden="true">
                    {repository.icon}
                  </span>
                ) : (
                  <Image src="/icon.png" alt="Trident" width={20} height={20} className="rounded shrink-0" />
                )}
                <span className="font-semibold text-xs tracking-tight text-base-content truncate">
                  {repoDisplayName || "Trident"}
                </span>
              </Link>
              <button
                className="btn btn-ghost btn-xs btn-square text-base-content/60 hover:text-base-content"
                onClick={toggleCollapsed} 
                title="Collapse sidebar"
              >
                <i className="iconoir-fast-arrow-left text-[15px]" aria-hidden="true" />
              </button>
            </>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <button
                className="btn btn-ghost btn-xs btn-square text-base-content/60 hover:text-base-content"
                onClick={toggleCollapsed} 
                title="Expand sidebar"
              >
                <i className="iconoir-fast-arrow-right text-[15px]" aria-hidden="true" />
              </button>
            </div>
          )}
        </div>

        {/* Repository Path Indicator (Expanded) */}
        {!isCollapsed && repoPath && (
          <div className="px-3 pt-2.5 pb-1 shrink-0">
            <div 
              className="px-2 py-1 rounded bg-base-100 border border-base-300/60 text-[10px] font-mono text-base-content/50 truncate" 
              title={repoPath}
            >
              {repoPath}
            </div>
          </div>
        )}

        {/* Nav Links */}
        <nav className="p-2 space-y-1 overflow-y-auto flex-1">
          <Link
            href={getHref()}
            className={cn(
              "flex items-center gap-2.5 rounded-md text-xs font-medium transition-colors",
              isCollapsed ? "justify-center h-8 w-8 mx-auto" : "px-2.5 py-1.5 w-full",
              isActive('history')
                ? "bg-base-100 text-base-content shadow-xs font-semibold border border-base-300/60"
                : "text-base-content/70 hover:text-base-content hover:bg-base-200/60"
            )}
            title={isCollapsed ? "History" : undefined}
          >
            <i className="iconoir-git-fork text-[17px] shrink-0" aria-hidden="true" />
            {!isCollapsed && <span>History</span>}
          </Link>

          <Link
            href={getHref('/conflicts')}
            className={cn(
              "flex items-center gap-2.5 rounded-md text-xs font-medium transition-colors relative",
              isCollapsed ? "justify-center h-8 w-8 mx-auto" : "px-2.5 py-1.5 w-full",
              isActive('conflicts')
                ? "bg-base-100 text-base-content shadow-xs font-semibold border border-base-300/60"
                : "text-base-content/70 hover:text-base-content hover:bg-base-200/60"
            )}
            title={isCollapsed ? `Conflicts${conflictsCount > 0 ? ` (${conflictsCount})` : ''}` : undefined}
          >
            <div className="relative shrink-0 flex items-center">
              <i className="iconoir-warning-triangle text-[17px]" aria-hidden="true" />
              {isCollapsed && conflictsCount > 0 && (
                <span className="absolute -top-1 -right-1.5 badge badge-error badge-xs scale-75">
                  {conflictsCount > 99 ? '99+' : conflictsCount}
                </span>
              )}
            </div>
            {!isCollapsed && (
              <span className="flex-1 flex justify-between items-center">
                <span>Conflicts</span>
                {conflictsCount > 0 && <span className="badge badge-xs badge-error text-[10px]">{conflictsCount}</span>}
              </span>
            )}
          </Link>

          <Link
            href={getHref('/stashes')}
            className={cn(
              "flex items-center gap-2.5 rounded-md text-xs font-medium transition-colors",
              isCollapsed ? "justify-center h-8 w-8 mx-auto" : "px-2.5 py-1.5 w-full",
              isActive('stashes')
                ? "bg-base-100 text-base-content shadow-xs font-semibold border border-base-300/60"
                : "text-base-content/70 hover:text-base-content hover:bg-base-200/60"
            )}
            title={isCollapsed ? "Stashes" : undefined}
          >
            <i className="iconoir-download-square text-[17px] shrink-0" aria-hidden="true" />
            {!isCollapsed && <span>Stashes</span>}
          </Link>

          {repository?.isWorktree ? (
            <div
              className={cn(
                "flex items-center gap-2.5 rounded-md text-xs font-medium opacity-40 cursor-not-allowed select-none",
                isCollapsed ? "justify-center h-8 w-8 mx-auto" : "px-2.5 py-1.5 w-full"
              )}
              title={isCollapsed ? "Custom scripts (disabled for worktrees)" : "Manage scripts is disabled for worktrees"}
            >
              <i className="iconoir-terminal text-[17px] shrink-0" aria-hidden="true" />
              {!isCollapsed && <span>Custom scripts</span>}
            </div>
          ) : (
            <Link
              href={getHref('/custom-scripts')}
              className={cn(
                "flex items-center gap-2.5 rounded-md text-xs font-medium transition-colors",
                isCollapsed ? "justify-center h-8 w-8 mx-auto" : "px-2.5 py-1.5 w-full",
                isActive('custom-scripts')
                  ? "bg-base-100 text-base-content shadow-xs font-semibold border border-base-300/60"
                  : "text-base-content/70 hover:text-base-content hover:bg-base-200/60"
              )}
              title={isCollapsed ? "Custom scripts" : undefined}
            >
              <i className="iconoir-terminal text-[17px] shrink-0" aria-hidden="true" />
              {!isCollapsed && <span>Custom scripts</span>}
            </Link>
          )}

          <Link
            href={getHref('/settings')}
            className={cn(
              "flex items-center gap-2.5 rounded-md text-xs font-medium transition-colors",
              isCollapsed ? "justify-center h-8 w-8 mx-auto" : "px-2.5 py-1.5 w-full",
              isActive('settings')
                ? "bg-base-100 text-base-content shadow-xs font-semibold border border-base-300/60"
                : "text-base-content/70 hover:text-base-content hover:bg-base-200/60"
            )}
            title={isCollapsed ? "Settings" : undefined}
          >
            <i className="iconoir-settings text-[17px] shrink-0" aria-hidden="true" />
            {!isCollapsed && <span>Settings</span>}
          </Link>
        </nav>
      </div>

      {/* Bottom Footer Section */}
      <div className={cn(
        "border-t border-base-300 shrink-0",
        isCollapsed ? "p-2 flex flex-col items-center gap-1.5" : "p-2 flex items-center justify-between"
      )}>
        {!isCollapsed ? (
          <>
            <button
              className="btn btn-ghost btn-xs gap-1.5 text-xs text-base-content/70 hover:text-base-content font-normal"
              onClick={() => setSettingsOpen(true)}
              title="Preferences"
            >
              <i className="iconoir-settings text-[15px]" aria-hidden="true" />
              <span>Preferences</span>
            </button>
            <div className="flex items-center gap-1">
              <ThemeToggle />
              <Link
                href="/"
                className="btn btn-ghost btn-xs btn-square text-base-content/70 hover:text-base-content"
                title="All Repositories"
              >
                <i className="iconoir-home text-[15px]" aria-hidden="true" />
              </Link>
            </div>
          </>
        ) : (
          <>
            <ThemeToggle />
            <button
              className="btn btn-ghost btn-xs btn-square text-base-content/70 hover:text-base-content"
              onClick={() => setSettingsOpen(true)}
              title="Preferences"
            >
              <i className="iconoir-settings text-[15px]" aria-hidden="true" />
            </button>
            <Link
              href="/"
              className="btn btn-ghost btn-xs btn-square text-base-content/70 hover:text-base-content"
              title="All Repositories"
            >
              <i className="iconoir-home text-[15px]" aria-hidden="true" />
            </Link>
          </>
        )}
      </div>

      <HomeSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
