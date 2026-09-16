'use client';

import { cn, getRepoFolderName, getRepositoryDisplayName } from '@/lib/utils';
import Link from 'next/link';
import { HomeSettingsModal } from '@/components/home-settings-modal';
import { usePathname, useSearchParams, useRouter } from 'next/navigation';
import { useState, useEffect, useCallback } from 'react';
import { useGitStatus, useRepository, useUpdateSettings } from '@/hooks/use-git';

const SIDEBAR_COLLAPSED_KEY = 'workspace-sidebar-collapsed';
const SIDEBAR_WIDTH_EXPANDED = 256; // w-64
const SIDEBAR_WIDTH_COLLAPSED = 64; // w-16

type SidebarProps = React.HTMLAttributes<HTMLDivElement>;
type SidebarPropsWithInitialState = SidebarProps & {
  initialCollapsed?: boolean;
};

export function Sidebar({ className, initialCollapsed = false }: SidebarPropsWithInitialState) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const router = useRouter();
  const repoPath = searchParams.get('path') || '';
  const repository = useRepository(repoPath || null);
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
    // Clean up tab if it exists from previous version, though we are moving away from it.
    p.delete('tab');
    if (repoPath && currentBranch) {
      p.set('branch', currentBranch);
    } else if (!repoPath) {
      p.delete('branch');
    }
    return `/workspace${subPath}?${p.toString()}`;
  };

  const isActive = (view: 'history' | 'conflicts' | 'custom-scripts' | 'settings' | 'stashes') => {
    if (view === 'history') return pathname === '/workspace' || pathname.startsWith('/workspace/history');
    if (view === 'conflicts') return pathname.startsWith('/workspace/conflicts');
    if (view === 'custom-scripts') return pathname.startsWith('/workspace/custom-scripts');
    if (view === 'settings') return pathname.startsWith('/workspace/settings');
    if (view === 'stashes') return pathname.startsWith('/workspace/stashes');
    return false;
  };

  // Calculate width
  const sidebarWidth = isCollapsed ? SIDEBAR_WIDTH_COLLAPSED : SIDEBAR_WIDTH_EXPANDED;

  return (
    <div 
      style={{ 
        width: sidebarWidth
      }}
      className={cn(
        "pb-12 border-r border-base-300 min-h-screen bg-base-100 relative",
        enableTransition && "transition-all duration-300",
        className
      )}
    >
      <div className="space-y-4 py-4">
        <div className={cn("px-3 py-2", isCollapsed && "px-2")}>
          <div className={cn("mb-6 flex items-center", isCollapsed ? "flex-col gap-2 px-0" : "justify-between px-4")}>
            {!isCollapsed && (
              <a
                href="/"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) {
                    // Cmd/Ctrl+click: open in new tab (default behavior)
                    return;
                  }
                  e.preventDefault();
                  router.push('/');
                }}
                className="flex items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer text-base-content overflow-hidden"
                title={repoDisplayName ? `${repoDisplayName} - Go to Home` : "Go to Home"}
              >
                {repository?.icon ? (
                  <span className="h-5 w-5 flex-shrink-0 flex items-center justify-center text-base leading-none" aria-hidden="true">
                    {repository.icon}
                  </span>
                ) : (
                  <img src="/icon.png" alt="Trident" className="h-5 w-5 flex-shrink-0" />
                )}
                <h2 className="text-lg font-bold tracking-tight truncate">
                  {repoDisplayName || "Trident"}
                </h2>
              </a>
            )}
            {isCollapsed && (
              <a
                href="/"
                onClick={(e) => {
                  if (e.metaKey || e.ctrlKey) {
                    // Cmd/Ctrl+click: open in new tab (default behavior)
                    return;
                  }
                  e.preventDefault();
                  router.push('/');
                }}
                className="flex items-center justify-center h-8 w-8 hover:opacity-80 transition-opacity cursor-pointer"
                title={repoDisplayName ? `${repoDisplayName} - Go to Home` : "Go to Home"}
              >
                {repository?.icon ? (
                  <span className="h-5 w-5 flex items-center justify-center text-base leading-none" aria-hidden="true">
                    {repository.icon}
                  </span>
                ) : (
                  <img src="/icon.png" alt={repoDisplayName || "Trident"} className="h-5 w-5" />
                )}
              </a>
            )}
            <div className={cn("flex items-center gap-1", isCollapsed && "flex-col")}>
              <button
                className="btn btn-ghost btn-sm btn-square"
                onClick={toggleCollapsed} 
                title={isCollapsed ? "Expand sidebar" : "Collapse sidebar"} 
              >
                {isCollapsed ? <i className="iconoir-fast-arrow-right text-[16px]" aria-hidden="true" /> : <i className="iconoir-fast-arrow-left text-[16px]" aria-hidden="true" />}
              </button>
            </div>
          </div>

          {!isCollapsed && repoPath && (
            <div className="px-4 mb-6">
              <p className="text-[10px] font-mono opacity-60 break-all border border-base-300 rounded p-2 bg-base-200/30" title={repoPath}>
                {repoPath}
              </p>
            </div>
          )}

          <div className="space-y-1">
            <Link
              href={getHref()}
              className={cn(
                "btn btn-ghost w-full justify-start font-normal",
                isCollapsed ? "px-0 justify-center" : "",
                isActive('history') && "btn-active font-medium"
              )}
              title={isCollapsed ? "History" : undefined}
            >
              <i className={cn("iconoir-git-fork text-[20px]", !isCollapsed && "mr-2")} aria-hidden="true" />
              {!isCollapsed && "History"}
            </Link>

            <Link
              href={getHref('/conflicts')}
              className={cn(
                "btn btn-ghost w-full justify-start font-normal",
                isCollapsed ? "px-0 justify-center" : "",
                isActive('conflicts') && "btn-active font-medium"
              )}
              title={isCollapsed ? `Conflicts${conflictsCount > 0 ? ` (${conflictsCount})` : ''}` : undefined}
            >
              <div className={cn("relative flex items-center", !isCollapsed && "mr-2")}>
                <i className="iconoir-warning-triangle text-[20px]" aria-hidden="true" />
                {isCollapsed && conflictsCount > 0 && (
                  <span className="absolute -top-1 -right-1 badge badge-error badge-xs scale-75">
                    {conflictsCount > 99 ? '99+' : conflictsCount}
                  </span>
                )}
              </div>
              {!isCollapsed && (
                <span className="flex-1 flex justify-between items-center">
                  Conflicts
                  {conflictsCount > 0 && <span className="badge badge-sm badge-error">{conflictsCount}</span>}
                </span>
              )}
            </Link>

            <Link
              href={getHref('/stashes')}
              className={cn(
                "btn btn-ghost w-full justify-start font-normal",
                isCollapsed ? "px-0 justify-center" : "",
                isActive('stashes') && "btn-active font-medium"
              )}
              title={isCollapsed ? "Stashes" : undefined}
            >
              <i className={cn("iconoir-download-square text-[20px]", !isCollapsed && "mr-2")} aria-hidden="true" />
              {!isCollapsed && "Stashes"}
            </Link>

            <Link
              href={getHref('/custom-scripts')}
              className={cn(
                "btn btn-ghost w-full justify-start font-normal",
                isCollapsed ? "px-0 justify-center" : "",
                isActive('custom-scripts') && "btn-active font-medium"
              )}
              title={isCollapsed ? "Custom scripts" : undefined}
            >
              <i className={cn("iconoir-terminal text-[20px]", !isCollapsed && "mr-2")} aria-hidden="true" />
              {!isCollapsed && "Custom scripts"}
            </Link>

            <Link
              href={getHref('/settings')}
              className={cn(
                "btn btn-ghost w-full justify-start font-normal",
                isCollapsed ? "px-0 justify-center" : "",
                isActive('settings') && "btn-active font-medium"
              )}
              title={isCollapsed ? "Settings" : undefined}
            >
              <i className={cn("iconoir-settings text-[20px]", !isCollapsed && "mr-2")} aria-hidden="true" />
              {!isCollapsed && "Settings"}
            </Link>
          </div>
        </div>
      </div>

      <div className={cn("absolute bottom-4 left-0 w-full", isCollapsed ? "px-2" : "px-6")}>
        <div className={cn("flex items-center", isCollapsed ? "justify-center" : "gap-2")}>
          <button
            className="btn btn-ghost btn-sm btn-square"
            onClick={() => setSettingsOpen(true)}
            title={isCollapsed ? "Preferences" : undefined}
          >
            <i className="iconoir-ios-settings text-[20px]" aria-hidden="true" />
          </button>
          {!isCollapsed && <span className="text-xs opacity-70">Preferences</span>}
        </div>
      </div>

      <HomeSettingsModal
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
      />
    </div>
  );
}
