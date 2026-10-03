'use client';

import { useCurrentRepo, useGitAction, useGitConflictFileVersions, useGitConflictState, useGitStatus, GitConflictFileVersions } from '@/hooks/use-git';
import { useState, useCallback } from 'react';
import { cn, isFileBinary } from '@/lib/utils';
import { toast } from '@/hooks/use-toast';
import { workspaceUrl } from '@/lib/workspace-url';
import { useRouter, useSearchParams } from 'next/navigation';
import { GroupedDiffViewer } from './grouped-diff-viewer';
import { useTheme } from 'next-themes';

type ResolveStrategy = 'ours' | 'theirs' | 'manual';

function operationLabel(operation: 'merge' | 'rebase' | null): string {
  if (operation === 'merge') return 'Merge';
  if (operation === 'rebase') return 'Rebase';
  return 'Conflict';
}

function ConflictEditor({
  filePath,
  versions,
  isBinary,
  onResolve,
  busy,
}: {
  filePath: string;
  versions: GitConflictFileVersions;
  isBinary: boolean;
  onResolve: (strategy: ResolveStrategy, options?: { content?: string; stage?: boolean }) => Promise<void>;
  busy: boolean;
}) {
  const [resolvedContent, setResolvedContent] = useState(
    versions.current || versions.ours || versions.theirs || ''
  );
  const { resolvedTheme } = useTheme();

  if (isBinary) {
    return (
      <div className="h-full p-6 flex flex-col gap-4">
        <h2 className="text-lg font-bold">Binary Conflict</h2>
        <p className="text-sm opacity-70">
          This conflicted file looks binary. Use one side to resolve it.
        </p>
        <div className="flex items-center gap-2">
          <button
            className="btn btn-sm"
            onClick={() => onResolve('ours', { stage: true })}
            disabled={busy}
          >
            Use Ours
          </button>
          <button
            className="btn btn-sm"
            onClick={() => onResolve('theirs', { stage: true })}
            disabled={busy}
          >
            Use Theirs
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-base-300 bg-base-100 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider opacity-60">Resolving</div>
          <div className="font-mono text-xs truncate" title={filePath}>{filePath}</div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn btn-xs" onClick={() => setResolvedContent(versions.ours)} disabled={busy}>Copy Ours</button>
          <button className="btn btn-xs" onClick={() => setResolvedContent(versions.theirs)} disabled={busy}>Copy Theirs</button>
          <button className="btn btn-xs btn-outline" onClick={() => void onResolve('manual', { content: resolvedContent, stage: false })} disabled={busy}>Save</button>
          <button className="btn btn-xs btn-primary" onClick={() => void onResolve('manual', { content: resolvedContent, stage: true })} disabled={busy}>Save + Stage</button>
        </div>
      </div>

      <div className="flex-1 min-h-0 border-b border-base-300 flex flex-col">
        <div className="grid grid-cols-2 gap-0 border-b border-base-300">
          <div className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-base-200/60 border-r border-base-300">Ours</div>
          <div className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-base-200/60">Theirs</div>
        </div>
        <div className="flex-1 min-h-0 overflow-auto diff-viewer-wrapper">
          <GroupedDiffViewer
            oldValue={versions.ours}
            newValue={versions.theirs}
            splitView={true}
            useDarkTheme={resolvedTheme === 'dark'}
            showDiffOnly={false}
          />
        </div>
      </div>

      <div className="flex-[1.2] min-h-0 flex flex-col">
        <div className="px-3 py-2 text-xs font-bold uppercase tracking-wider bg-base-200/60 border-b border-base-300">Resolved (Editable)</div>
        <textarea
          value={resolvedContent}
          onChange={(e) => setResolvedContent(e.target.value)}
          className="textarea textarea-ghost h-full w-full rounded-none resize-none font-mono text-xs leading-5"
          spellCheck={false}
        />
      </div>

      <div className="px-4 py-2 border-t border-base-300 bg-base-100 flex items-center justify-end gap-2">
        <button className="btn btn-sm" onClick={() => void onResolve('ours', { stage: true })} disabled={busy}>Use Ours + Stage</button>
        <button className="btn btn-sm" onClick={() => void onResolve('theirs', { stage: true })} disabled={busy}>Use Theirs + Stage</button>
      </div>
    </div>
  );
}

export function ConflictResolverView({ repoPath }: { repoPath: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const repoName = useCurrentRepo().repo?.name ?? '';
  const { data: status, isLoading: isStatusLoading, isError: isStatusError, error: statusError, refetch: refetchStatus } = useGitStatus(repoPath);
  const {
    data: conflictState,
    isLoading: isConflictStateLoading,
    isError: isConflictStateError,
    error: conflictStateError,
    refetch: refetchConflictState,
  } = useGitConflictState(repoPath);
  const { mutateAsync: runGitAction, isPending: isActionPending } = useGitAction();

  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  const conflictedFiles = status?.conflicted ?? [];
  const unresolvedSet = new Set(conflictedFiles);
  const resolvedFiles = (status?.files ?? [])
    .filter((file) => !unresolvedSet.has(file.path) && file.index === ' ' && file.working_dir !== ' ')
    .map((file) => file.path);
  const stagedResolvedFiles = (status?.files ?? [])
    .filter((file) => !unresolvedSet.has(file.path) && file.index !== ' ')
    .map((file) => file.path);
  const effectiveSelectedFile = selectedFile && conflictedFiles.includes(selectedFile)
    ? selectedFile
    : conflictedFiles[0] ?? null;

  const {
    data: versions,
    isLoading: isVersionsLoading,
    isError: isVersionsError,
    error: versionsError,
    refetch: refetchVersions,
  } = useGitConflictFileVersions(repoPath, effectiveSelectedFile);

  const operation = conflictState?.operation ?? null;

  const buildWorkspaceHref = useCallback((subPath: string = '') => {
    return workspaceUrl(repoName, subPath, searchParams);
  }, [repoName, searchParams]);

  const refreshAll = useCallback(async () => {
    await Promise.all([refetchStatus(), refetchConflictState(), refetchVersions()]);
  }, [refetchConflictState, refetchStatus, refetchVersions]);

  const handleResolve = async (
    path: string,
    strategy: ResolveStrategy,
    options: { content?: string; stage?: boolean } = {},
  ) => {
    await runGitAction({
      repoPath,
      action: 'resolve-conflict-file',
      data: {
        path,
        strategy,
        content: options.content,
        stage: options.stage ?? true,
      },
    });

    await refreshAll();

    toast({
      type: 'success',
      title: 'Conflict Updated',
      description: strategy === 'manual'
        ? (options.stage === false ? 'Saved manual resolution.' : 'Saved and staged manual resolution.')
        : `Applied ${strategy} version${options.stage === false ? '' : ' and staged it'}.`,
    });
  };

  const handleStageResolved = async (filePath: string) => {
    await runGitAction({
      repoPath,
      action: 'stage',
      data: { files: [filePath] },
    });

    await refreshAll();
  };

  const handleAbort = async () => {
    const action = operation === 'rebase' ? 'abort-rebase' : operation === 'merge' ? 'abort-merge' : null;
    if (!action) return;

    await runGitAction({
      repoPath,
      action,
    });

    toast({
      type: 'info',
      title: `${operationLabel(operation)} Aborted`,
      description: `The ${operationLabel(operation).toLowerCase()} operation was aborted.`,
    });

    router.push(buildWorkspaceHref());
  };

  const handleContinue = async () => {
    const action = operation === 'rebase' ? 'continue-rebase' : operation === 'merge' ? 'continue-merge' : null;
    if (!action) return;

    await runGitAction({
      repoPath,
      action,
    });

    toast({
      type: 'success',
      title: `${operationLabel(operation)} Completed`,
      description: `${operationLabel(operation)} continued successfully.`,
    });

    router.push(buildWorkspaceHref());
  };

  if (isStatusLoading || isConflictStateLoading) {
    return <div className="flex items-center justify-center h-64"><span className="loading loading-spinner text-base-content/50"></span></div>;
  }

  if (isStatusError || isConflictStateError) {
    return (
      <div className="flex items-center justify-center h-64 flex-col gap-4">
        <p className="text-error font-bold">Error Loading Conflicts</p>
        <p className="text-sm opacity-70">{(statusError as Error)?.message || (conflictStateError as Error)?.message || 'An unknown error occurred'}</p>
        <button onClick={() => void refreshAll()} className="btn btn-outline btn-sm" disabled={isActionPending}>
          <i className="iconoir-refresh-circle text-[16px] mr-1" aria-hidden="true" />
          Try Again
        </button>
      </div>
    );
  }

  const isOperationInProgress = Boolean(operation);
  const hasConflicts = conflictedFiles.length > 0;
  const canContinue = Boolean(conflictState?.canContinue) && isOperationInProgress;
  const isSelectedFileBinary = effectiveSelectedFile
    ? isFileBinary(effectiveSelectedFile, versions?.ours, versions?.theirs || versions?.current)
    : false;

  return (
    <div className="flex h-full overflow-hidden">
      <div className="w-80 border-r border-base-300 flex flex-col bg-base-200/30">
        <div className="h-12 px-4 border-b border-base-300 flex items-center justify-between bg-base-100">
          <h1 className="font-bold text-lg">Conflicts</h1>
          <button className="btn btn-ghost btn-sm btn-square" onClick={() => void refreshAll()} disabled={isActionPending} title="Refresh">
            <i className="iconoir-refresh-circle text-[16px]" aria-hidden="true" />
          </button>
        </div>

        <div className="p-4 border-b border-base-300 space-y-2">
          <div className="text-xs opacity-70">Operation</div>
          <div className="flex items-center justify-between">
            <span className={cn('badge', isOperationInProgress ? 'badge-warning' : 'badge-ghost')}>
              {isOperationInProgress ? operationLabel(operation) : 'None'}
            </span>
            <span className={cn('badge', hasConflicts ? 'badge-error' : 'badge-success')}>
              {hasConflicts ? `${conflictedFiles.length} unresolved` : 'No unresolved'}
            </span>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          <div className="px-2 py-2 text-xs font-bold uppercase tracking-wider opacity-70">Unresolved Files</div>
          <div className="space-y-0.5">
            {conflictedFiles.length === 0 && (
              <p className="px-2 py-2 text-xs opacity-50 italic">No unresolved conflicts.</p>
            )}
            {conflictedFiles.map((file) => (
              <div key={file} className={cn(
                'rounded-md border border-transparent',
                effectiveSelectedFile === file && 'bg-base-300 border-base-300'
              )}>
                <button
                  className={cn(
                    'w-full text-left flex items-center gap-2 px-2 py-2 rounded-md text-sm hover:bg-base-300 transition-colors',
                    effectiveSelectedFile === file && 'text-primary font-medium'
                  )}
                  onClick={() => setSelectedFile(file)}
                  title={file}
                >
                  <i className="iconoir-warning-triangle text-[14px] text-error shrink-0" aria-hidden="true" />
                  <span className="truncate font-mono text-xs">{file}</span>
                </button>
                <div className="px-2 pb-2 flex items-center gap-1">
                  <button className="btn btn-xs" onClick={() => void handleResolve(file, 'ours', { stage: true })} disabled={isActionPending}>Ours</button>
                  <button className="btn btn-xs" onClick={() => void handleResolve(file, 'theirs', { stage: true })} disabled={isActionPending}>Theirs</button>
                </div>
              </div>
            ))}
          </div>

          {resolvedFiles.length > 0 && (
            <>
              <div className="h-px bg-base-300 mx-2 my-3" />
              <div className="px-2 py-2 text-xs font-bold uppercase tracking-wider opacity-70">Ready to Stage</div>
              <div className="space-y-1">
                {resolvedFiles.map((file) => (
                  <div key={file} className="flex items-center gap-2 px-2 py-1.5 rounded-md bg-base-100 border border-base-300">
                    <span className="truncate font-mono text-xs flex-1" title={file}>{file}</span>
                    <button
                      className="btn btn-xs btn-success"
                      onClick={() => void handleStageResolved(file)}
                      disabled={isActionPending}
                      title="Stage as resolved"
                    >
                      Stage
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}

          {stagedResolvedFiles.length > 0 && (
            <>
              <div className="h-px bg-base-300 mx-2 my-3" />
              <div className="px-2 py-2 text-xs font-bold uppercase tracking-wider opacity-70">Staged Resolutions</div>
              <div className="space-y-1">
                {stagedResolvedFiles.map((file) => (
                  <div key={file} className="px-2 py-1.5 rounded-md bg-success/10 border border-success/20">
                    <span className="truncate font-mono text-xs" title={file}>{file}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="border-t border-base-300 p-3 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <button
              className="btn btn-primary btn-sm"
              onClick={() => void handleContinue()}
              disabled={!canContinue || isActionPending}
            >
              Continue
            </button>
            <button
              className="btn btn-error btn-outline btn-sm"
              onClick={() => void handleAbort()}
              disabled={!isOperationInProgress || isActionPending}
            >
              Abort
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 flex flex-col bg-base-100 overflow-hidden">
        {!effectiveSelectedFile ? (
          <div className="flex-1 flex items-center justify-center opacity-60">
            <div className="text-center">
              <div className="p-8 rounded-full bg-base-200 mb-4 text-4xl mx-auto w-fit">
                <i className="iconoir-warning-triangle text-[32px]" aria-hidden="true" />
              </div>
              <p className="text-sm font-bold">Select a conflicted file to resolve</p>
              <p className="text-xs opacity-70 mt-2">Pick ours/theirs or edit manually.</p>
            </div>
          </div>
        ) : isVersionsLoading ? (
          <div className="flex-1 flex items-center justify-center"><span className="loading loading-spinner" /></div>
        ) : isVersionsError || !versions ? (
          <div className="flex-1 flex items-center justify-center flex-col gap-3">
            <p className="text-error font-bold">Failed to load file versions</p>
            <p className="text-xs opacity-70">{(versionsError as Error)?.message || 'Unknown error'}</p>
            <button className="btn btn-sm btn-outline" onClick={() => void refetchVersions()}>Retry</button>
          </div>
        ) : (
          <ConflictEditor
            key={`${effectiveSelectedFile}:${versions.ours.length}:${versions.theirs.length}:${versions.current.length}`}
            filePath={effectiveSelectedFile}
            versions={versions}
            isBinary={isSelectedFileBinary}
            onResolve={(strategy, options) => handleResolve(effectiveSelectedFile, strategy, options)}
            busy={isActionPending}
          />
        )}
      </div>
    </div>
  );
}
