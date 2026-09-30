'use client';

import { useRepositories, useAddRepository, useDeleteRepository, useCloneRepository } from '@/hooks/use-git';
import { useCredentials, useGitHubRepositories, type Credential } from '@/hooks/use-credentials';
import { useState, useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FileSystemBrowser } from './fs-browser';
import { toast } from '@/hooks/use-toast';
import { HomeSettingsModal } from './home-settings-modal';
import { getRepositoryDisplayName, formatRelativeTime, formatFullDateTime } from '@/lib/utils';
import { ThemeToggle } from './theme-toggle';
import Image from 'next/image';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';

function getRemoteHostname(url: string): string | null {
    try {
        if (url.startsWith('git@')) {
            const match = url.match(/^git@([^:]+):/);
            return match ? match[1] : null;
        }
        return new URL(url).hostname;
    } catch {
        return null;
    }
}

function inferFolderNameFromRepoUrl(repoUrl: string): string | null {
    const sanitized = repoUrl.trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
    if (!sanitized) return null;

    const lastSlashIndex = sanitized.lastIndexOf('/');
    const lastColonIndex = sanitized.lastIndexOf(':');
    const splitIndex = Math.max(lastSlashIndex, lastColonIndex);
    const rawName = splitIndex >= 0 ? sanitized.slice(splitIndex + 1) : sanitized;
    const normalized = rawName.endsWith('.git') ? rawName.slice(0, -4) : rawName;
    const trimmed = normalized.trim();

    return trimmed.length > 0 ? trimmed : null;
}

function formatCredentialLabel(credential: Credential): string {
    if (credential.type === 'github') {
        return `GitHub (${credential.username})`;
    }
    return `GitLab (${new URL(credential.serverUrl).hostname} - ${credential.username})`;
}

export function RepoList() {
    const { data: repos, isLoading } = useRepositories();
    const { data: credentials } = useCredentials();
    const addRepo = useAddRepository();
    const cloneRepo = useCloneRepository();
    const deleteRepo = useDeleteRepository();
    const [browserOpen, setBrowserOpen] = useState(false);
    const [cloneDialogOpen, setCloneDialogOpen] = useState(false);
    const [cloneFolderBrowserOpen, setCloneFolderBrowserOpen] = useState(false);
    const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
    const [initRepoDialogOpen, setInitRepoDialogOpen] = useState(false);
    const [selectedNonRepoPath, setSelectedNonRepoPath] = useState<string | null>(null);
    const [repoToDelete, setRepoToDelete] = useState<{ path: string; displayName: string } | null>(null);
    const [settingsOpen, setSettingsOpen] = useState(false);
    const [defaultRootFolder, setDefaultRootFolder] = useState<string | undefined>(undefined);
    const [cloneUrl, setCloneUrl] = useState('');
    const [cloneDestinationParent, setCloneDestinationParent] = useState('');
    const [cloneFolderName, setCloneFolderName] = useState('');
    const [cloneFolderNameTouched, setCloneFolderNameTouched] = useState(false);
    const [cloneCredentialId, setCloneCredentialId] = useState('auto');
    const [searchQuery, setSearchQuery] = useState('');
    const router = useRouter();
    const closeCloneDialog = () => {
        setCloneFolderBrowserOpen(false);
        setCloneDialogOpen(false);
    };

    const sortedRepos = useMemo(() => {
        if (!repos) return [];
        return [...repos].sort((a, b) => {
            const aTime = a.lastOpenedAt ? new Date(a.lastOpenedAt).getTime() : 0;
            const bTime = b.lastOpenedAt ? new Date(b.lastOpenedAt).getTime() : 0;
            if (aTime !== bTime) {
                return bTime - aTime;
            }
            const aName = getRepositoryDisplayName(a).toLowerCase();
            const bName = getRepositoryDisplayName(b).toLowerCase();
            return aName.localeCompare(bName);
        });
    }, [repos]);

    const filteredRepos = useMemo(() => {
        const q = searchQuery.trim().toLowerCase();
        if (!q) return sortedRepos;
        return sortedRepos.filter((repo) => {
            const name = getRepositoryDisplayName(repo).toLowerCase();
            return name.includes(q) || repo.path.toLowerCase().includes(q);
        });
    }, [sortedRepos, searchQuery]);
    // Load settings on mount
    useEffect(() => {
        const loadSettings = async () => {
            try {
                const res = await fetch('/api/settings');
                if (res.ok) {
                    const data = await res.json();
                    setDefaultRootFolder(data.resolvedDefaultFolder);
                }
            } catch (e) {
                console.error('Failed to load settings:', e);
            }
        };
        loadSettings();
    }, []);

    const matchingCredentials = useMemo(() => {
        if (!credentials?.length || !cloneUrl.trim()) return [];

        const remoteHost = getRemoteHostname(cloneUrl.trim());
        if (!remoteHost) return [];

        return credentials.filter((cred) => {
            if (cred.type === 'github') {
                return remoteHost === 'github.com';
            }
            return getRemoteHostname(cred.serverUrl) === remoteHost;
        });
    }, [credentials, cloneUrl]);

    const autoCredential = matchingCredentials[0] ?? null;
    const orderedCredentials = useMemo(() => {
        if (!credentials) return [];
        const matchingIds = new Set(matchingCredentials.map((cred) => cred.id));
        return [
            ...matchingCredentials,
            ...credentials.filter((cred) => !matchingIds.has(cred.id)),
        ];
    }, [credentials, matchingCredentials]);
    const selectedCredential = useMemo(() => {
        if (cloneCredentialId === 'auto') {
            return null;
        }
        return orderedCredentials.find((credential) => credential.id === cloneCredentialId) ?? null;
    }, [cloneCredentialId, orderedCredentials]);
    const selectedGithubCredentialId = selectedCredential?.type === 'github' ? selectedCredential.id : null;
    const {
        data: githubRepositories,
        isLoading: isGitHubRepositoriesLoading,
        error: githubRepositoriesError,
    } = useGitHubRepositories(selectedGithubCredentialId);

    const handleAdd = async (path: string) => {
        if (!path) return;
        try {
            await addRepo.mutateAsync({ path });
            // Navigate to workspace page after successfully adding repository
            router.push(`/workspace?path=${encodeURIComponent(path)}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            
            if (errorMessage.includes('already exists')) {
                toast({
                    type: 'warning',
                    title: 'Repository already added',
                    description: 'This repository is already in your list. Select it from the list to open it.',
                });
            } else {
                toast({
                    type: 'error',
                    title: 'Failed to add repository',
                    description: errorMessage,
                });
            }
        }
    };

    const handleRepoSelection = (path: string, meta: { isRepo: boolean }) => {
        if (!path) return;
        if (meta.isRepo) {
            handleAdd(path);
            return;
        }

        setSelectedNonRepoPath(path);
        setInitRepoDialogOpen(true);
    };

    const handleConfirmInitRepo = async () => {
        if (!selectedNonRepoPath) return;

        try {
            await addRepo.mutateAsync({ path: selectedNonRepoPath, initializeIfNeeded: true });
            setInitRepoDialogOpen(false);
            setSelectedNonRepoPath(null);
            router.push(`/workspace?path=${encodeURIComponent(selectedNonRepoPath)}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            toast({
                type: 'error',
                title: 'Failed to initialize repository',
                description: errorMessage,
            });
        }
    };

    const handleCancelInitRepo = () => {
        setInitRepoDialogOpen(false);
        setSelectedNonRepoPath(null);
        setBrowserOpen(true);
    };

    const openCloneDialog = () => {
        setCloneUrl('');
        setCloneFolderName('');
        setCloneFolderNameTouched(false);
        setCloneCredentialId('auto');
        setCloneDestinationParent(defaultRootFolder || '');
        setCloneDialogOpen(true);
    };

    const handleCloneUrlChange = (value: string) => {
        setCloneUrl(value);
        if (!cloneFolderNameTouched) {
            setCloneFolderName(inferFolderNameFromRepoUrl(value) ?? '');
        }
    };

    const handleClone = async () => {
        const trimmedUrl = cloneUrl.trim();
        const trimmedParent = cloneDestinationParent.trim();
        const trimmedFolderName = cloneFolderName.trim();

        if (!trimmedUrl) {
            toast({
                type: 'error',
                title: 'Repository URL is required',
                description: 'Enter a repository URL to clone.',
            });
            return;
        }

        if (!trimmedParent) {
            toast({
                type: 'error',
                title: 'Destination folder is required',
                description: 'Select a local destination folder first.',
            });
            return;
        }

        const folderName = trimmedFolderName || inferFolderNameFromRepoUrl(trimmedUrl);
        if (!folderName) {
            toast({
                type: 'error',
                title: 'Folder name is required',
                description: 'Provide a destination folder name for this clone.',
            });
            return;
        }

        try {
            const clonedRepo = await cloneRepo.mutateAsync({
                repoUrl: trimmedUrl,
                destinationParent: trimmedParent,
                folderName,
                credentialId: cloneCredentialId === 'auto' ? null : cloneCredentialId,
            });

            const usedCredential = credentials?.find((cred) => cred.id === clonedRepo.usedCredentialId);
            toast({
                type: 'success',
                title: 'Repository cloned',
                description: usedCredential
                    ? `Cloned with ${formatCredentialLabel(usedCredential)}`
                    : 'Clone completed successfully.',
            });
            setCloneDialogOpen(false);
            setCloneFolderBrowserOpen(false);
            router.push(`/workspace?path=${encodeURIComponent(clonedRepo.path)}`);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            toast({
                type: 'error',
                title: 'Failed to clone repository',
                description: errorMessage,
            });
        }
    };

    const handleDeleteClick = (e: React.MouseEvent, repo: { path: string; displayName: string }) => {
        e.stopPropagation();
        setRepoToDelete(repo);
        setDeleteDialogOpen(true);
    };

    const handleDeleteConfirm = async (deleteLocalFolder: boolean) => {
        if (!repoToDelete) return;
        try {
            await deleteRepo.mutateAsync({ path: repoToDelete.path, deleteLocalFolder });
            setDeleteDialogOpen(false);
            setRepoToDelete(null);
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            toast({
                type: 'error',
                title: 'Failed to delete repository',
                description: errorMessage,
            });
        }
    };

    useEscapeDismiss(deleteDialogOpen, () => setDeleteDialogOpen(false), () => {
        if (deleteRepo.isPending) {
            return;
        }
        void handleDeleteConfirm(false);
    });
    useEscapeDismiss(cloneDialogOpen, closeCloneDialog, () => {
        if (cloneRepo.isPending) {
            return;
        }
        void handleClone();
    });
    useEscapeDismiss(initRepoDialogOpen, () => {
        setInitRepoDialogOpen(false);
        setSelectedNonRepoPath(null);
        setBrowserOpen(true);
    }, () => {
        if (addRepo.isPending) {
            return;
        }
        void handleConfirmInitRepo();
    });

    if (isLoading) {
        return (
            <div className="flex-1 flex items-center justify-center p-12">
                <span className="loading loading-spinner text-base-content/40"></span>
            </div>
        );
    }

    return (
        <div className="w-full max-w-7xl mx-auto px-6 py-6 flex flex-col gap-5 flex-1">
            {/* Top Minimalist Header */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-base-300">
                <div className="flex items-center gap-3">
                    <Image
                        src="/icon.png"
                        alt="Trident"
                        width={28}
                        height={28}
                        className="rounded-md shrink-0"
                        priority
                    />
                    <div>
                        <h1 className="text-lg font-bold tracking-tight text-base-content leading-none">Repositories</h1>
                        <p className="text-xs text-base-content/60 mt-1">Manage and explore your Git repositories</p>
                    </div>
                </div>

                <div className="flex items-center flex-wrap gap-2">
                    {/* Search filter input */}
                    <div className="relative">
                        <i className="iconoir-search absolute left-2.5 top-1/2 -translate-y-1/2 text-[14px] text-base-content/40 pointer-events-none" aria-hidden="true" />
                        <input
                            type="text"
                            placeholder="Filter repos..."
                            value={searchQuery}
                            onChange={(e) => setSearchQuery(e.target.value)}
                            className="input input-sm input-bordered pl-8 pr-3 w-48 text-xs bg-base-100 focus:w-64 transition-all duration-150"
                        />
                        {searchQuery && (
                            <button
                                onClick={() => setSearchQuery('')}
                                className="absolute right-2 top-1/2 -translate-y-1/2 text-xs opacity-50 hover:opacity-100"
                            >
                                ✕
                            </button>
                        )}
                    </div>

                    <ThemeToggle />

                    <button
                        className="btn btn-sm btn-ghost btn-square"
                        onClick={() => setSettingsOpen(true)}
                        title="Settings"
                    >
                        <i className="iconoir-settings text-[18px]" aria-hidden="true" />
                    </button>

                    <a
                        href="https://github.com/oscarqht/trident"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-sm btn-ghost btn-square"
                        title="View GitHub Repository"
                    >
                        <i className="iconoir-github text-[18px]" aria-hidden="true" />
                    </a>

                    <div className="h-4 w-px bg-base-300 mx-1 hidden sm:block" />

                    <Link href="/credentials" className="btn btn-sm btn-ghost border border-base-300 gap-1.5 text-xs">
                        <i className="iconoir-key text-[15px]" aria-hidden="true" />
                        Credentials
                    </Link>
                    <button onClick={openCloneDialog} className="btn btn-sm btn-ghost border border-base-300 gap-1.5 text-xs">
                        <i className="iconoir-git-fork text-[15px]" aria-hidden="true" />
                        Clone
                    </button>
                    <button onClick={() => setBrowserOpen(true)} className="btn btn-sm btn-primary gap-1.5 text-xs">
                        <i className="iconoir-plus text-[16px]" aria-hidden="true" />
                        Add Repository
                    </button>
                </div>
            </div>

            {/* Repositories Table / List */}
            <div className="border border-base-300 rounded-lg overflow-hidden bg-base-100">
                <table className="w-full text-left text-xs border-collapse">
                    <thead>
                        <tr className="border-b border-base-300 bg-base-200/50 text-[11px] font-semibold uppercase tracking-wider text-base-content/60">
                            <th className="py-2.5 px-4 font-semibold">Repository</th>
                            <th className="py-2.5 px-4 font-semibold hidden md:table-cell">Path</th>
                            <th className="py-2.5 px-4 font-semibold">Last Active</th>
                            <th className="py-2.5 px-4 font-semibold text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-base-300/60">
                        {filteredRepos.length === 0 && (
                            <tr>
                                <td colSpan={4} className="text-center py-16 text-base-content/60">
                                    <div className="flex flex-col items-center gap-3 max-w-sm mx-auto">
                                        <div className="w-12 h-12 rounded-full bg-base-200 flex items-center justify-center text-base-content/40">
                                            <i className="iconoir-folder-search text-2xl" aria-hidden="true" />
                                        </div>
                                        <div className="space-y-1">
                                            <p className="font-medium text-sm text-base-content">
                                                {searchQuery ? 'No matching repositories found' : 'No repositories added yet'}
                                            </p>
                                            <p className="text-xs text-base-content/60">
                                                {searchQuery ? `No results matching "${searchQuery}"` : 'Open a local Git repository or clone one from remote to get started.'}
                                            </p>
                                        </div>
                                        {!searchQuery && (
                                            <div className="flex items-center gap-2 pt-1">
                                                <button className="btn btn-sm btn-primary gap-1.5 text-xs" onClick={() => setBrowserOpen(true)}>
                                                    <i className="iconoir-plus text-sm" />
                                                    Add Repository
                                                </button>
                                                <button className="btn btn-sm btn-ghost border border-base-300 gap-1.5 text-xs" onClick={openCloneDialog}>
                                                    <i className="iconoir-git-fork text-sm" />
                                                    Clone
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                </td>
                            </tr>
                        )}
                        {filteredRepos.map((repo) => {
                            const repoDisplayName = getRepositoryDisplayName(repo);
                            return (
                                <tr
                                    key={repo.path}
                                    className="hover:bg-base-200/40 cursor-pointer transition-colors group"
                                    onClick={() => router.push(`/workspace?path=${encodeURIComponent(repo.path)}`)}
                                >
                                    <td className="py-3 px-4">
                                        <div className="flex items-center gap-2.5">
                                            {repo.icon ? (
                                                <span className="text-[18px] leading-none w-5 text-center shrink-0" aria-hidden="true">{repo.icon}</span>
                                            ) : (
                                                <i className="iconoir-folder text-[18px] text-base-content/40 group-hover:text-primary transition-colors shrink-0" aria-hidden="true" />
                                            )}
                                            <span className="font-semibold text-sm text-base-content group-hover:text-primary transition-colors truncate">
                                                {repoDisplayName}
                                            </span>
                                        </div>
                                    </td>
                                    <td className="py-3 px-4 hidden md:table-cell text-base-content/60 font-mono text-xs truncate max-w-md" title={repo.path}>
                                        {repo.path}
                                    </td>
                                    <td className="py-3 px-4 text-base-content/60 whitespace-nowrap" title={formatFullDateTime(repo.lastOpenedAt)}>
                                        {formatRelativeTime(repo.lastOpenedAt)}
                                    </td>
                                    <td className="py-3 px-4 text-right">
                                        <div className="flex items-center justify-end gap-1">
                                            <Link
                                                href={`/workspace?path=${encodeURIComponent(repo.path)}`}
                                                className="btn btn-ghost btn-xs btn-square opacity-70 group-hover:opacity-100"
                                                onClick={(e) => e.stopPropagation()}
                                                title="Open in Workspace"
                                            >
                                                <i className="iconoir-arrow-right text-[15px]" aria-hidden="true" />
                                            </Link>
                                            <button
                                                className="btn btn-ghost btn-xs btn-square text-error/70 hover:text-error hover:bg-error/10 opacity-70 group-hover:opacity-100"
                                                onClick={(e) => handleDeleteClick(e, { path: repo.path, displayName: repoDisplayName })}
                                                title="Remove Repository"
                                            >
                                                <i className="iconoir-trash text-[15px]" aria-hidden="true" />
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>

            <FileSystemBrowser
                open={browserOpen}
                onOpenChange={setBrowserOpen}
                onSelect={handleRepoSelection}
                initialPath={defaultRootFolder}
            />

            <HomeSettingsModal
                open={settingsOpen}
                onOpenChange={setSettingsOpen}
                onSettingsChange={(settings) => setDefaultRootFolder(settings.resolvedDefaultFolder)}
            />

            {cloneDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box max-w-2xl">
                        <h3 className="font-bold text-lg">Clone Repository</h3>
                        <p className="py-2 text-sm opacity-70">
                            Clone a remote repository into a local folder and add it to your repository list.
                        </p>

                        <div className="space-y-4 pt-2">
                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Repository URL</span>
                                </label>
                                <input
                                    type="text"
                                    className="input input-bordered w-full"
                                    placeholder="https://github.com/org/repo.git"
                                    value={cloneUrl}
                                    onChange={(e) => handleCloneUrlChange(e.target.value)}
                                />
                            </div>

                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Destination Parent Folder</span>
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        type="text"
                                        className="input input-bordered w-full font-mono text-sm"
                                        value={cloneDestinationParent}
                                        onChange={(e) => setCloneDestinationParent(e.target.value)}
                                        placeholder={defaultRootFolder || '/path/to/folder'}
                                    />
                                    <button
                                        type="button"
                                        className="btn btn-outline"
                                        onClick={() => setCloneFolderBrowserOpen(true)}
                                    >
                                        Browse
                                    </button>
                                </div>
                            </div>

                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Destination Folder Name</span>
                                </label>
                                <input
                                    type="text"
                                    className="input input-bordered w-full"
                                    value={cloneFolderName}
                                    onChange={(e) => {
                                        setCloneFolderNameTouched(true);
                                        setCloneFolderName(e.target.value);
                                    }}
                                    placeholder={inferFolderNameFromRepoUrl(cloneUrl) || 'repository-name'}
                                />
                            </div>

                            <div className="form-control">
                                <label className="label">
                                    <span className="label-text">Credential</span>
                                </label>
                                <select
                                    className="select select-bordered w-full"
                                    value={cloneCredentialId}
                                    onChange={(e) => setCloneCredentialId(e.target.value)}
                                >
                                    <option value="auto">
                                        {autoCredential
                                            ? `Auto detect (${formatCredentialLabel(autoCredential)})`
                                            : 'Auto detect'}
                                    </option>
                                    {orderedCredentials.map((credential) => (
                                        <option key={credential.id} value={credential.id}>
                                            {formatCredentialLabel(credential)}
                                        </option>
                                    ))}
                                </select>
                                {cloneUrl.trim() && matchingCredentials.length === 0 && (
                                    <label className="label">
                                        <span className="label-text-alt opacity-70">
                                            No matching credential found for this URL. Clone will run without stored credentials unless you pick one.
                                        </span>
                                    </label>
                                )}
                                {selectedGithubCredentialId && (
                                    <div className="mt-3 border border-base-300 rounded-lg bg-base-200/30 p-2">
                                        <p className="text-xs font-bold opacity-70 px-2 pb-2">
                                            Your GitHub repositories (recently updated first)
                                        </p>
                                        {isGitHubRepositoriesLoading && (
                                            <div className="px-2 py-3 text-sm opacity-70">Loading repositories...</div>
                                        )}
                                        {!isGitHubRepositoriesLoading && githubRepositoriesError && (
                                            <div className="px-2 py-3 text-sm text-error">
                                                {githubRepositoriesError instanceof Error
                                                    ? githubRepositoriesError.message
                                                    : 'Failed to load repositories'}
                                            </div>
                                        )}
                                        {!isGitHubRepositoriesLoading && !githubRepositoriesError && githubRepositories?.length === 0 && (
                                            <div className="px-2 py-3 text-sm opacity-70">
                                                No accessible repositories found for this account.
                                            </div>
                                        )}
                                        {!isGitHubRepositoriesLoading && !githubRepositoriesError && (githubRepositories?.length ?? 0) > 0 && (
                                            <div className="max-h-56 overflow-y-auto">
                                                {githubRepositories?.map((repo) => (
                                                    <button
                                                        key={repo.id}
                                                        type="button"
                                                        className={`w-full text-left px-2 py-2 rounded-md hover:bg-base-300/60 transition-colors ${cloneUrl.trim() === repo.cloneUrl ? 'bg-base-300/60' : ''}`}
                                                        onClick={() => handleCloneUrlChange(repo.cloneUrl)}
                                                        title={repo.cloneUrl}
                                                    >
                                                        <div className="flex items-center justify-between gap-2">
                                                            <span className="text-sm font-medium truncate">{repo.fullName}</span>
                                                            {repo.private && (
                                                                <span className="text-[10px] uppercase tracking-wide opacity-70">Private</span>
                                                            )}
                                                        </div>
                                                        <div className="text-xs font-mono opacity-60 truncate">{repo.cloneUrl}</div>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        </div>

                        <div className="modal-action">
                            <button className="btn" onClick={closeCloneDialog} disabled={cloneRepo.isPending}>Cancel</button>
                            <button className="btn btn-primary" onClick={handleClone} disabled={cloneRepo.isPending}>
                                {cloneRepo.isPending ? (
                                    <span className="flex items-center gap-2">
                                        <span className="loading loading-spinner loading-xs" />
                                        Cloning...
                                    </span>
                                ) : (
                                    'Clone'
                                )}
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={closeCloneDialog}>close</button>
                    </form>
                </dialog>
            )}

            <FileSystemBrowser
                open={cloneFolderBrowserOpen}
                onOpenChange={setCloneFolderBrowserOpen}
                onSelect={(path) => setCloneDestinationParent(path)}
                initialPath={cloneDestinationParent || defaultRootFolder}
                title="Select Destination Folder"
                selectionMode="folder"
            />

            {initRepoDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box max-w-xl">
                        <h3 className="font-bold text-lg">Initialize New Repository?</h3>
                        <p className="py-4">
                            <span className="break-all font-mono text-sm">{selectedNonRepoPath}</span>
                            <br />
                            This folder is not a Git repository. Initialize it as a new local Git repository and open it in workspace?
                        </p>
                        <div className="modal-action">
                            <button className="btn" onClick={handleCancelInitRepo} disabled={addRepo.isPending}>No</button>
                            <button className="btn btn-primary" onClick={handleConfirmInitRepo} disabled={addRepo.isPending}>
                                {addRepo.isPending ? (
                                    <span className="flex items-center gap-2">
                                        <span className="loading loading-spinner loading-xs" />
                                        Initializing...
                                    </span>
                                ) : (
                                    'Yes, Initialize'
                                )}
                            </button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={handleCancelInitRepo}>close</button>
                    </form>
                </dialog>
            )}

            {deleteDialogOpen && (
                <dialog className="modal modal-open">
                    <div className="modal-box">
                        <h3 className="font-bold text-lg">Delete Repository</h3>
                        <p className="py-4 break-words">
                            Are you sure you want to remove <strong className="break-all">{repoToDelete?.displayName}</strong> from the list? 
                            Choose whether to only remove it from your repository list, or also delete its local folder.
                        </p>
                        <div className="modal-action">
                            <button className="btn" onClick={() => setDeleteDialogOpen(false)} disabled={deleteRepo.isPending}>Cancel</button>
                            <button className="btn btn-error btn-outline" onClick={() => handleDeleteConfirm(false)} disabled={deleteRepo.isPending}>Delete Repo</button>
                            <button className="btn btn-error" onClick={() => handleDeleteConfirm(true)} disabled={deleteRepo.isPending}>Delete Repo &amp; Folder</button>
                        </div>
                    </div>
                    <form method="dialog" className="modal-backdrop">
                        <button onClick={() => setDeleteDialogOpen(false)}>close</button>
                    </form>
                </dialog>
            )}
        </div>
    );
}
