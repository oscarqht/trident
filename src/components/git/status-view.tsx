'use client';

import { useGitStatus, useGitAction, useGitBranches } from '@/hooks/use-git';
import { useCallback, useMemo, useState, useEffect, useRef } from 'react';
import { cn, sanitizeBranchName } from '@/lib/utils';
import { DiffView } from './diff-view';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';

const EMPTY_FILES: Array<{ path: string; index: string; working_dir: string }> = [];

function buildCommitMessage(subject: string, body: string): string {
    const trimmedSubject = subject.trim();
    const normalizedBody = body.replace(/\r\n/g, '\n');
    return normalizedBody.trim() ? `${trimmedSubject}\n\n${normalizedBody}` : trimmedSubject;
}

interface StatusFileTreeNode {
    name: string;
    path: string;
    filePath?: string;
    children: Map<string, StatusFileTreeNode>;
}

function buildStatusFileTree(paths: string[]): StatusFileTreeNode {
    const root: StatusFileTreeNode = {
        name: '',
        path: '',
        children: new Map(),
    };

    for (const filePath of paths) {
        const parts = filePath.split('/').filter(Boolean);
        let current = root;
        let currentPath = '';

        for (let i = 0; i < parts.length; i++) {
            const part = parts[i];
            currentPath = currentPath ? `${currentPath}/${part}` : part;

            if (!current.children.has(part)) {
                current.children.set(part, {
                    name: part,
                    path: currentPath,
                    children: new Map(),
                });
            }

            current = current.children.get(part)!;

            if (i === parts.length - 1) {
                current.filePath = filePath;
            }
        }
    }

    return root;
}

function collectFolderPaths(node: StatusFileTreeNode): string[] {
    const paths: string[] = [];
    const children = Array.from(node.children.values());

    children.forEach((child) => {
        if (child.children.size > 0) {
            paths.push(child.path);
            paths.push(...collectFolderPaths(child));
        }
    });

    return paths;
}

function getParentPaths(filePath: string): string[] {
    const parts = filePath.split('/').filter(Boolean);
    const parentPaths: string[] = [];

    for (let i = 1; i < parts.length; i++) {
        parentPaths.push(parts.slice(0, i).join('/'));
    }

    return parentPaths;
}

function StatusFileTreeItem({
    node,
    selectedFile,
    expandedFolders,
    onToggleFolder,
    onSelectFile,
    onActionFile,
    actionType,
    actionPending,
    depth = 0,
}: {
    node: StatusFileTreeNode;
    selectedFile: string | null;
    expandedFolders: Set<string>;
    onToggleFolder: (path: string) => void;
    onSelectFile: (path: string) => void;
    onActionFile: (path: string) => Promise<void>;
    actionType: 'stage' | 'unstage';
    actionPending: boolean;
    depth?: number;
}) {
    const children = Array.from(node.children.values()).sort((a, b) => {
        const aIsFolder = a.children.size > 0;
        const bIsFolder = b.children.size > 0;

        if (aIsFolder && !bIsFolder) return -1;
        if (!aIsFolder && bIsFolder) return 1;
        return a.name.localeCompare(b.name);
    });

    return (
        <>
            {children.map((child) => {
                const isFolder = child.children.size > 0;

                if (isFolder) {
                    const isExpanded = expandedFolders.has(child.path);

                    return (
                        <div key={child.path}>
                            <div
                                className="flex items-center gap-1 px-2 py-1.5 text-xs rounded cursor-pointer hover:bg-base-300 transition-colors opacity-80"
                                style={{ paddingLeft: `${depth * 12 + 8}px` }}
                                onClick={() => onToggleFolder(child.path)}
                                title={child.path}
                            >
                                <span className="text-[10px] opacity-70">{isExpanded ? '▼' : '▶'}</span>
                                <i className="iconoir-folder text-[14px] opacity-70" aria-hidden="true" />
                                <span className="truncate flex-1">{child.name}</span>
                            </div>
                            {isExpanded && (
                                <StatusFileTreeItem
                                    node={child}
                                    selectedFile={selectedFile}
                                    expandedFolders={expandedFolders}
                                    onToggleFolder={onToggleFolder}
                                    onSelectFile={onSelectFile}
                                    onActionFile={onActionFile}
                                    actionType={actionType}
                                    actionPending={actionPending}
                                    depth={depth + 1}
                                />
                            )}
                        </div>
                    );
                }

                const filePath = child.filePath;
                if (!filePath) return null;

                return (
                    <div
                        key={filePath}
                        className={cn(
                            'flex items-center justify-between gap-2 px-2 py-1.5 rounded-md cursor-pointer group hover:bg-base-300 transition-colors text-sm',
                            selectedFile === filePath && 'bg-base-300 font-medium text-primary'
                        )}
                        style={{ paddingLeft: `${depth * 12 + 8}px` }}
                        onClick={() => onSelectFile(filePath)}
                        title={filePath}
                    >
                        <div className="flex items-center gap-2 min-w-0 flex-1">
                            <i className="iconoir-page text-[14px] opacity-70 shrink-0" aria-hidden="true" />
                            <span className="truncate flex-1 font-mono text-xs">{child.name}</span>
                        </div>
                        <button
                            className={cn(
                                'btn btn-ghost btn-xs btn-square opacity-0 group-hover:opacity-100 transition-opacity',
                                actionType === 'stage'
                                    ? 'text-success hover:bg-success/10'
                                    : 'text-error hover:bg-error/10'
                            )}
                            onClick={(e) => {
                                e.stopPropagation();
                                void onActionFile(filePath);
                            }}
                            disabled={actionPending}
                        >
                            <i
                                className={cn(
                                    'text-[14px]',
                                    actionType === 'stage' ? 'iconoir-plus-circle' : 'iconoir-minus-circle'
                                )}
                                aria-hidden="true"
                            />
                        </button>
                    </div>
                );
            })}
        </>
    );
}

export function StatusView({ repoPath, onClose }: { repoPath: string; onClose?: () => void }) {
    const { data: status, isLoading, isError, error, refetch } = useGitStatus(repoPath);
    const { data: branches } = useGitBranches(repoPath);
    const action = useGitAction();
    const [subject, setSubject] = useState('');
    const [body, setBody] = useState('');
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [stashDialogOpen, setStashDialogOpen] = useState(false);
    const [stashMessage, setStashMessage] = useState('');
    const [discardDialogOpen, setDiscardDialogOpen] = useState(false);
    const [firstCommitDialogOpen, setFirstCommitDialogOpen] = useState(false);
    const [initialBranchName, setInitialBranchName] = useState('main');
    const [collapsedChangeFolders, setCollapsedChangeFolders] = useState<Set<string>>(new Set());
    const [collapsedStagedFolders, setCollapsedStagedFolders] = useState<Set<string>>(new Set());
    const [isAmend, setIsAmend] = useState(false);
    const [isPushed, setIsPushed] = useState(false);
    const [draftSubject, setDraftSubject] = useState('');
    const [draftBody, setDraftBody] = useState('');
    const [isLoadingAmend, setIsLoadingAmend] = useState(false);
    
    // Resize logic for commit box
    const [commitBoxHeight, setCommitBoxHeight] = useState(180);
    const [isResizing, setIsResizing] = useState(false);
    const resizeRef = useRef<{ startY: number; startHeight: number } | null>(null);

    useEffect(() => {
        const handleMouseMove = (e: MouseEvent) => {
            if (!isResizing || !resizeRef.current) return;
            const delta = resizeRef.current.startY - e.clientY;
            const newHeight = Math.max(120, Math.min(600, resizeRef.current.startHeight + delta));
            setCommitBoxHeight(newHeight);
        };

        const handleMouseUp = () => {
            setIsResizing(false);
            resizeRef.current = null;
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        };

        if (isResizing) {
            window.addEventListener('mousemove', handleMouseMove);
            window.addEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'ns-resize';
            document.body.style.userSelect = 'none';
        }

        return () => {
            window.removeEventListener('mousemove', handleMouseMove);
            window.removeEventListener('mouseup', handleMouseUp);
            document.body.style.cursor = 'default';
            document.body.style.userSelect = 'auto';
        };
    }, [isResizing]);

    const handleResizeStart = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsResizing(true);
        resizeRef.current = { startY: e.clientY, startHeight: commitBoxHeight };
    };

    const files = status?.files ?? EMPTY_FILES;
    const isFirstCommit = !!branches && branches.branches.length === 0;

    // Group files
    const { staged, changes } = useMemo(() => {
        const stagedFiles: string[] = [];
        const changedFiles: string[] = [];

        files.forEach((file) => {
            if (file.index !== ' ' && file.index !== '?') {
                stagedFiles.push(file.path);
            }
            if (file.working_dir !== ' ' || file.index === '?') {
                changedFiles.push(file.path);
            }
        });

        return {
            staged: stagedFiles,
            changes: changedFiles,
        };
    }, [files]);

    const changesTree = useMemo(() => buildStatusFileTree(changes), [changes]);
    const stagedTree = useMemo(() => buildStatusFileTree(staged), [staged]);
    const allChangeFolderPaths = useMemo(() => collectFolderPaths(changesTree), [changesTree]);
    const allStagedFolderPaths = useMemo(() => collectFolderPaths(stagedTree), [stagedTree]);

    const expandedChangeFolders = useMemo(() => {
        const expanded = new Set<string>();

        allChangeFolderPaths.forEach((path) => {
            if (!collapsedChangeFolders.has(path)) {
                expanded.add(path);
            }
        });

        if (selectedFile) {
            getParentPaths(selectedFile).forEach((path) => expanded.add(path));
        }

        return expanded;
    }, [allChangeFolderPaths, collapsedChangeFolders, selectedFile]);

    const expandedStagedFolders = useMemo(() => {
        const expanded = new Set<string>();

        allStagedFolderPaths.forEach((path) => {
            if (!collapsedStagedFolders.has(path)) {
                expanded.add(path);
            }
        });

        if (selectedFile) {
            getParentPaths(selectedFile).forEach((path) => expanded.add(path));
        }

        return expanded;
    }, [allStagedFolderPaths, collapsedStagedFolders, selectedFile]);

    const handleToggleChangeFolder = useCallback((path: string) => {
        setCollapsedChangeFolders((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    }, []);

    const handleToggleStagedFolder = useCallback((path: string) => {
        setCollapsedStagedFolders((prev) => {
            const next = new Set(prev);
            if (next.has(path)) {
                next.delete(path);
            } else {
                next.add(path);
            }
            return next;
        });
    }, []);

    const handleStage = async (file: string) => {
        await action.mutateAsync({ repoPath, action: 'stage', data: { files: [file] } });
    };

    const handleUnstage = async (file: string) => {
        await action.mutateAsync({ repoPath, action: 'unstage', data: { files: [file] } });
    };

    const handleStageAll = async () => {
        await action.mutateAsync({ repoPath, action: 'stage', data: { files: ['.'] } });
    }

    const handleUnstageAll = async () => {
        await action.mutateAsync({ repoPath, action: 'unstage', data: { files: staged } });
    }

    const handleStash = async () => {
        await action.mutateAsync({ repoPath, action: 'stash', data: { message: stashMessage || undefined } });
        setStashDialogOpen(false);
        setStashMessage('');
        setSelectedFile(null);
    }

    const handleDiscard = async () => {
        await action.mutateAsync({ repoPath, action: 'discard', data: { includeUntracked: true } });
        setDiscardDialogOpen(false);
        setSelectedFile(null);
    }

    const handleToggleAmend = async (checked: boolean) => {
        if (checked) {
            setDraftSubject(subject);
            setDraftBody(body);
            setIsAmend(true);
            setIsLoadingAmend(true);
            try {
                const res = await action.mutateAsync({
                    repoPath,
                    action: 'get-latest-commit-message',
                    data: { branch: branches?.current || 'HEAD' },
                });
                if (res?.subject !== undefined) {
                    setSubject(res.subject || '');
                    setBody(res.body || '');
                } else if (typeof res?.message === 'string') {
                    const [firstLine, ...rest] = res.message.split('\n');
                    setSubject(firstLine || '');
                    setBody(rest.join('\n').trim());
                }
                setIsPushed(Boolean(res?.isPushed));
            } catch (err) {
                console.error('Failed to load last commit info:', err);
            } finally {
                setIsLoadingAmend(false);
            }
        } else {
            setIsAmend(false);
            setIsPushed(false);
            setSubject(draftSubject);
            setBody(draftBody);
        }
    };

    const handleCommit = async () => {
        const trimmedSubject = subject.trim();
        if (!trimmedSubject) return;

        if (isFirstCommit) {
            setFirstCommitDialogOpen(true);
            return;
        }

        await action.mutateAsync({
            repoPath,
            action: 'commit',
            data: {
                message: buildCommitMessage(trimmedSubject, body),
                amend: isAmend,
            },
        });
        setSubject('');
        setBody('');
        setDraftSubject('');
        setDraftBody('');
        setIsAmend(false);
        setIsPushed(false);
        setSelectedFile(null);
    };

    const handleFirstCommitConfirm = async () => {
        const trimmedSubject = subject.trim();
        const trimmedBranchName = initialBranchName.trim();
        if (!trimmedSubject || !trimmedBranchName) return;

        await action.mutateAsync({
            repoPath,
            action: 'commit',
            data: {
                message: buildCommitMessage(trimmedSubject, body),
                initialBranch: trimmedBranchName,
            },
        });

        setSubject('');
        setBody('');
        setDraftSubject('');
        setDraftBody('');
        setIsAmend(false);
        setIsPushed(false);
        setSelectedFile(null);
        setFirstCommitDialogOpen(false);
    };

    useEscapeDismiss(stashDialogOpen, () => setStashDialogOpen(false), () => {
        if (action.isPending) {
            return;
        }
        void handleStash();
    });
    useEscapeDismiss(discardDialogOpen, () => setDiscardDialogOpen(false), () => {
        if (action.isPending) {
            return;
        }
        void handleDiscard();
    });
    useEscapeDismiss(firstCommitDialogOpen, () => setFirstCommitDialogOpen(false), () => {
        if (action.isPending || !initialBranchName.trim()) {
            return;
        }
        void handleFirstCommitConfirm();
    });

    const handleCommitShortcut = (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            const canCommit = isAmend ? !!subject.trim() : (staged.length > 0 && !!subject.trim());
            if (canCommit && !action.isPending && !isLoadingAmend) {
                handleCommit();
            }
        }
    };

    if (isLoading) {
        return <div className="flex items-center justify-center h-64"><span className="loading loading-spinner text-base-content/50"></span></div>;
    }

    if (isError) {
        return (
            <div className="flex items-center justify-center h-64 flex-col gap-4">
                <p className="text-error font-bold">Error Loading Status</p>
                <p className="text-sm opacity-70">{(error as Error)?.message || 'An unknown error occurred'}</p>
                <button onClick={() => refetch()} className="btn btn-outline btn-sm">
                    <i className="iconoir-refresh-circle text-[16px] mr-1" aria-hidden="true" />
                    Try Again
                </button>
            </div>
        );
    }

    if (!status) return <div className="flex items-center justify-center h-64 opacity-70">No status data available</div>;

    return (
        <div className="flex flex-col h-full overflow-hidden bg-base-100">
            {/* Top Bar Header */}
            <div className="h-12 flex items-center justify-between px-4 border-b border-base-300 bg-base-100 shrink-0">
                <div className="flex items-center gap-3 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm">Local Changes</span>
                        {files.length > 0 && (
                            <span className="badge badge-sm badge-ghost text-xs">
                                {staged.length > 0 ? `${staged.length} staged, ${changes.length} unstaged` : `${changes.length} changes`}
                            </span>
                        )}
                        {branches?.current && (
                            <span className="text-xs opacity-60 truncate">
                                {branches.current === 'HEAD' || branches.isDetached ? (
                                    <span className="text-warning font-semibold">
                                        detached at {branches.detachedHeadCommit || 'HEAD'}
                                    </span>
                                ) : (
                                    <>on <span className="font-mono font-semibold">{branches.current}</span></>
                                )}
                            </span>
                        )}
                    </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                    <button
                        className="btn btn-ghost btn-xs btn-square"
                        onClick={() => refetch()}
                        disabled={action.isPending}
                        title="Refresh status"
                    >
                        {action.isPending ? (
                            <span className="loading loading-spinner loading-xs"></span>
                        ) : (
                            <i className="iconoir-refresh-circle text-[14px]" aria-hidden="true" />
                        )}
                    </button>
                    {onClose && (
                        <button
                            className="btn btn-ghost btn-xs btn-square"
                            onClick={onClose}
                            title="Close"
                        >
                            ✕
                        </button>
                    )}
                </div>
            </div>

            {/* Main Split Panel Area */}
            <div className="flex-1 flex overflow-hidden min-h-0">
                {/* Left Panel: File Trees */}
                <div className="w-72 border-r border-base-300 flex flex-col bg-base-200/30 shrink-0">
                    <div className="flex-1 overflow-y-auto">
                        {/* Unstaged Changes */}
                        <div className="p-2">
                            <div className="flex items-center justify-between px-2 py-1.5 mb-1">
                                <h3 className="text-xs font-bold uppercase tracking-wider opacity-70">
                                    Changes ({changes.length})
                                </h3>
                                <div className="flex items-center gap-0.5">
                                    {changes.length === 0 && staged.length > 0 ? (
                                        <button className="btn btn-ghost btn-xs btn-square" onClick={handleUnstageAll} title="Unstage All">
                                            <i className="iconoir-arrow-up text-[14px]" aria-hidden="true" />
                                        </button>
                                    ) : (
                                        <button className="btn btn-ghost btn-xs btn-square" onClick={handleStageAll} disabled={changes.length === 0} title="Stage All">
                                            <i className="iconoir-arrow-down text-[14px]" aria-hidden="true" />
                                        </button>
                                    )}
                                    <button className="btn btn-ghost btn-xs btn-square" onClick={() => setStashDialogOpen(true)} disabled={changes.length === 0 && staged.length === 0} title="Stash">
                                        <i className="iconoir-download-square text-[14px]" aria-hidden="true" />
                                    </button>
                                    <button className="btn btn-ghost btn-xs btn-square text-error hover:bg-error/10" onClick={() => setDiscardDialogOpen(true)} disabled={changes.length === 0} title="Discard All">
                                        <i className="iconoir-trash text-[14px]" aria-hidden="true" />
                                    </button>
                                </div>
                            </div>
                            <div className="space-y-0.5">
                                {changes.length === 0 && <p className="px-2 py-1 text-xs opacity-50 italic">No unstaged changes</p>}
                                {changes.length > 0 && (
                                    <StatusFileTreeItem
                                        node={changesTree}
                                        selectedFile={selectedFile}
                                        expandedFolders={expandedChangeFolders}
                                        onToggleFolder={handleToggleChangeFolder}
                                        onSelectFile={setSelectedFile}
                                        onActionFile={handleStage}
                                        actionType="stage"
                                        actionPending={action.isPending}
                                    />
                                )}
                            </div>
                        </div>

                        <div className="h-px bg-base-300 mx-3 my-1" />

                        {/* Staged Changes */}
                        <div className="p-2">
                            <div className="flex items-center justify-between px-2 py-1.5 mb-1">
                                <h3 className="text-xs font-bold uppercase tracking-wider opacity-70">
                                    Staged ({staged.length})
                                </h3>
                                {staged.length > 0 && (
                                    <button className="btn btn-ghost btn-xs btn-square" onClick={handleUnstageAll} title="Unstage All">
                                        <i className="iconoir-arrow-up text-[14px]" aria-hidden="true" />
                                    </button>
                                )}
                            </div>
                            <div className="space-y-0.5">
                                {staged.length === 0 && <p className="px-2 py-1 text-xs opacity-50 italic">No staged changes</p>}
                                {staged.length > 0 && (
                                    <StatusFileTreeItem
                                        node={stagedTree}
                                        selectedFile={selectedFile}
                                        expandedFolders={expandedStagedFolders}
                                        onToggleFolder={handleToggleStagedFolder}
                                        onSelectFile={setSelectedFile}
                                        onActionFile={handleUnstage}
                                        actionType="unstage"
                                        actionPending={action.isPending}
                                    />
                                )}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Right Panel: Diff View & Commit Box */}
                <div className="flex-1 flex flex-col bg-base-100 overflow-hidden min-h-0">
                    {/* Diff View Area */}
                    <div className="flex-1 overflow-hidden flex flex-col min-h-0">
                        {selectedFile ? (
                            <div className="h-full flex flex-col">
                                <DiffView repoPath={repoPath} filePath={selectedFile} />
                            </div>
                        ) : (
                            <div className="flex-1 flex flex-col items-center justify-center opacity-50 p-4">
                                <i className="iconoir-page-flip text-[32px] mb-2 opacity-60" aria-hidden="true" />
                                <p className="text-xs font-semibold">Select a file to view changes</p>
                            </div>
                        )}
                    </div>

                    {/* Resize Handle */}
                    <div
                        className="h-1.5 cursor-ns-resize flex items-center justify-center hover:bg-base-200 transition-colors group shrink-0 border-t border-base-300"
                        onMouseDown={handleResizeStart}
                    >
                        <div className="w-8 h-1 rounded-full bg-base-300 group-hover:bg-base-400 transition-colors" />
                    </div>

                    {/* Commit Box */}
                    <div
                        className="flex flex-col border-t border-base-300 bg-base-100 shrink-0"
                        style={{ height: commitBoxHeight }}
                    >
                        <div className="flex-1 p-3 overflow-y-auto flex flex-col gap-2">
                            <input
                                type="text"
                                placeholder={isAmend ? "Amend commit subject..." : "Commit subject..."}
                                value={subject}
                                onChange={e => setSubject(e.target.value)}
                                onKeyDown={handleCommitShortcut}
                                className="input input-bordered input-sm w-full text-sm font-sans shrink-0"
                            />
                            <textarea
                                placeholder="Commit message body (optional)..."
                                value={body}
                                onChange={e => setBody(e.target.value)}
                                onKeyDown={handleCommitShortcut}
                                className="textarea textarea-bordered textarea-sm w-full text-sm resize-none font-sans flex-1 min-h-[48px]"
                            />
                            {isAmend && isPushed && (
                                <div className="flex items-center gap-1.5 text-xs text-warning bg-warning/10 px-2 py-1 rounded shrink-0">
                                    <i className="iconoir-warning-triangle text-sm shrink-0" aria-hidden="true" />
                                    <span className="truncate">Last commit was already pushed to remote. Amending will require force push.</span>
                                </div>
                            )}
                            <div className="flex items-center justify-between gap-2 shrink-0 pt-0.5">
                                <div className="flex items-center gap-3">
                                    <label className={cn(
                                        "flex items-center gap-1.5 text-xs cursor-pointer select-none",
                                        (isFirstCommit || action.isPending) && "opacity-40 cursor-not-allowed"
                                    )}>
                                        <input
                                            type="checkbox"
                                            className="checkbox checkbox-xs"
                                            checked={isAmend}
                                            disabled={isFirstCommit || action.isPending}
                                            onChange={(e) => void handleToggleAmend(e.target.checked)}
                                        />
                                        <span className="font-medium">Amend</span>
                                        {isLoadingAmend && <span className="loading loading-spinner loading-xs text-primary" />}
                                    </label>
                                    <span className="text-[11px] opacity-40">
                                        <kbd className="kbd kbd-xs">⌘</kbd>+<kbd className="kbd kbd-xs">Enter</kbd> to {isAmend ? 'amend' : 'commit'}
                                    </span>
                                </div>
                                <button
                                    className="btn btn-primary btn-sm"
                                    onClick={handleCommit}
                                    disabled={(!isAmend && staged.length === 0) || !subject.trim() || action.isPending || isLoadingAmend}
                                >
                                    {action.isPending ? (
                                        <span className="loading loading-spinner loading-xs mr-1"></span>
                                    ) : (
                                        <i className="iconoir-check text-[14px] mr-1" aria-hidden="true" />
                                    )}
                                    {isAmend ? 'Amend Commit' : 'Commit Changes'}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Stash Dialog */}
            {stashDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">Stash Changes</h3>
                        <p className="py-4 opacity-70">Save your local modifications to a new stash entry.</p>
                        <div className="py-2">
                            <input
                                type="text"
                                placeholder="Stash message (optional)"
                                value={stashMessage}
                                onChange={(e) => setStashMessage(e.target.value)}
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleStash();
                                    }
                                }}
                                className="input input-bordered w-full"
                            />
                        </div>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setStashDialogOpen(false)}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleStash} disabled={action.isPending}>
                                {action.isPending && <span className="loading loading-spinner loading-xs"></span>}
                                Stash
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setStashDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}

            {/* Discard Dialog */}
            {discardDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">Discard Changes</h3>
                        <p className="py-4">
                            Are you sure you want to discard all unstaged changes and new files? This action cannot be undone.
                        </p>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setDiscardDialogOpen(false)}>Cancel</button>
                            <button className="btn btn-error" onClick={handleDiscard} disabled={action.isPending}>
                                {action.isPending && <span className="loading loading-spinner loading-xs"></span>}
                                Discard
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setDiscardDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}

            {firstCommitDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">First Commit Branch</h3>
                        <p className="py-4 opacity-70">
                            This repository has no commits yet. Choose the branch name for the first commit.
                        </p>
                        <div className="py-2">
                            <input
                                type="text"
                                placeholder="Branch name"
                                value={initialBranchName}
                                onChange={(e) => setInitialBranchName(sanitizeBranchName(e.target.value))}
                                autoFocus
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        e.preventDefault();
                                        handleFirstCommitConfirm();
                                    }
                                }}
                                className="input input-bordered w-full"
                            />
                        </div>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setFirstCommitDialogOpen(false)}>
                                Cancel
                            </button>
                            <button className="btn btn-primary" onClick={handleFirstCommitConfirm} disabled={!initialBranchName.trim() || action.isPending}>
                                {action.isPending && <span className="loading loading-spinner loading-xs"></span>}
                                Commit to Branch
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setFirstCommitDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}
        </div>
    );
}
