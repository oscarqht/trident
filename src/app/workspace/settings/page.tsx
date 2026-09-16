'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { useWorkspaceTitle } from '@/hooks/use-workspace-title';
import { useRepositories, useUpdateRepository, useGitBranches } from '@/hooks/use-git';
import { useCredentials } from '@/hooks/use-credentials';
import { getRepoFolderName, getRepositoryDisplayName } from '@/lib/utils';

function getHostname(url: string): string | null {
  try {
    // Handle git@github.com:user/repo.git format
    if (url.startsWith('git@')) {
      const match = url.match(/git@([^:]+):/);
      return match ? match[1] : null;
    }
    // Handle https://github.com/user/repo.git format
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function WorkspaceSettingsContent() {
    const searchParams = useSearchParams();
    const repoPath = searchParams.get('path');

    useWorkspaceTitle(repoPath, 'Settings');

    const { data: repos, isLoading: isLoadingRepos } = useRepositories();
    const { data: credentials, isLoading: isLoadingCreds } = useCredentials();
    const { data: gitData, isLoading: isLoadingGit } = useGitBranches(repoPath);
    const updateRepo = useUpdateRepository();

    const currentRepo = useMemo(() => 
        repos?.find(r => r.path === repoPath), 
    [repos, repoPath]);
    const [displayNameDraftState, setDisplayNameDraftState] = useState<{
        path: string | null;
        value: string;
        isDirty: boolean;
    }>({
        path: null,
        value: '',
        isDirty: false,
    });
    const [iconDraftState, setIconDraftState] = useState<{
        path: string | null;
        value: string;
        isDirty: boolean;
    }>({
        path: null,
        value: '',
        isDirty: false,
    });

    const matchingCredentials = useMemo(() => {
        if (!credentials || !gitData?.remoteUrls) return [];

        // specific remote URLs
        const urls = Object.values(gitData.remoteUrls);
        const remoteHosts = new Set(urls.map(getHostname).filter(Boolean) as string[]);

        return credentials.filter(cred => {
            if (cred.type === 'github') {
                return remoteHosts.has('github.com');
            }
            if (cred.type === 'gitlab' && cred.serverUrl) {
                const credHost = getHostname(cred.serverUrl);
                return credHost && remoteHosts.has(credHost);
            }
            return false;
        });
    }, [credentials, gitData]);

    const isLoading = isLoadingRepos || isLoadingCreds || isLoadingGit;

    if (isLoading) {
        return <div className="flex items-center justify-center h-full"><span className="loading loading-spinner"></span></div>;
    }

    if (!repoPath || !currentRepo) {
        return <div className="p-8">Repository not found.</div>;
    }

    const displayNameDraft = displayNameDraftState.path === repoPath && displayNameDraftState.isDirty
        ? displayNameDraftState.value
        : (currentRepo.displayName ?? '');
    const normalizedSavedDisplayName = currentRepo.displayName?.trim() ?? '';
    const normalizedDraftDisplayName = displayNameDraft.trim();
    const isDisplayNameDirty = normalizedDraftDisplayName !== normalizedSavedDisplayName;
    const previewName = getRepositoryDisplayName({
        path: currentRepo.path,
        name: currentRepo.name,
        displayName: displayNameDraft,
    });
    const fallbackFolderName = getRepoFolderName(currentRepo.path);

    const iconDraft = iconDraftState.path === repoPath && iconDraftState.isDirty
        ? iconDraftState.value
        : (currentRepo.icon ?? '');
    const normalizedSavedIcon = currentRepo.icon?.trim() ?? '';
    const normalizedDraftIcon = iconDraft.trim();
    const isIconDirty = normalizedDraftIcon !== normalizedSavedIcon;

    const handleDisplayNameSave = () => {
        setDisplayNameDraftState({
            path: repoPath,
            value: displayNameDraft,
            isDirty: false,
        });
        updateRepo.mutate({
            path: repoPath,
            updates: { displayName: displayNameDraft }
        });
    };

    const handleDisplayNameReset = () => {
        setDisplayNameDraftState({
            path: repoPath,
            value: '',
            isDirty: false,
        });
        updateRepo.mutate({
            path: repoPath,
            updates: { displayName: null }
        });
    };

    const handleIconSave = () => {
        setIconDraftState({
            path: repoPath,
            value: iconDraft,
            isDirty: false,
        });
        updateRepo.mutate({
            path: repoPath,
            updates: { icon: iconDraft }
        });
    };

    const handleIconReset = () => {
        setIconDraftState({
            path: repoPath,
            value: '',
            isDirty: false,
        });
        updateRepo.mutate({
            path: repoPath,
            updates: { icon: null }
        });
    };

    const handleCredentialChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
        const credentialId = e.target.value;
        updateRepo.mutate({
            path: repoPath,
            updates: { credentialId: credentialId === 'none' ? null : credentialId }
        });
    };

    return (
        <div className="p-8 max-w-2xl mx-auto">
            <h1 className="text-2xl font-bold mb-6">Workspace Settings</h1>

            <div className="space-y-6">
                <div className="card bg-base-100 shadow-xl border border-base-200">
                    <div className="card-body">
                        <h2 className="card-title">Repository Icon</h2>
                        <p className="text-sm opacity-70">
                            Set an emoji to represent this repository in the sidebar and repository list.
                        </p>

                        <div className="form-control w-full mt-4">
                            <label className="label">
                                <span className="label-text">Icon (emoji)</span>
                            </label>
                            <input
                                type="text"
                                className="input input-bordered w-24 text-center text-2xl"
                                placeholder="🔧"
                                value={iconDraft}
                                onChange={(e) => {
                                    // Emoji can span multiple UTF-16 code units (e.g. flags, ZWJ sequences).
                                    const chars = Array.from(e.target.value);
                                    setIconDraftState({
                                        path: repoPath,
                                        value: chars.slice(-1).join(''),
                                        isDirty: true,
                                    });
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && isIconDirty && !updateRepo.isPending) {
                                        e.preventDefault();
                                        handleIconSave();
                                    }
                                }}
                            />
                        </div>

                        <div className="flex items-center gap-2 mt-2">
                            <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={handleIconSave}
                                disabled={!isIconDirty || updateRepo.isPending}
                            >
                                Save Icon
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={handleIconReset}
                                disabled={(!normalizedDraftIcon && !currentRepo.icon) || updateRepo.isPending}
                            >
                                Reset
                            </button>
                        </div>
                    </div>
                </div>

                <div className="card bg-base-100 shadow-xl border border-base-200">
                    <div className="card-body">
                        <h2 className="card-title">Repository Display Name</h2>
                        <p className="text-sm opacity-70">
                            Set a custom name for this repository in the workspace UI.
                        </p>

                        <div className="form-control w-full mt-4">
                            <label className="label">
                                <span className="label-text">Display Name</span>
                            </label>
                            <input
                                type="text"
                                className="input input-bordered w-full"
                                placeholder={fallbackFolderName}
                                value={displayNameDraft}
                                onChange={(e) => {
                                    setDisplayNameDraftState({
                                        path: repoPath,
                                        value: e.target.value,
                                        isDirty: true,
                                    });
                                }}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && isDisplayNameDirty && !updateRepo.isPending) {
                                        e.preventDefault();
                                        handleDisplayNameSave();
                                    }
                                }}
                            />
                            <label className="label">
                                <span className="label-text-alt opacity-70">
                                    Preview: <span className="font-medium">{previewName}</span>
                                </span>
                            </label>
                        </div>

                        <div className="flex items-center gap-2 mt-2">
                            <button
                                type="button"
                                className="btn btn-primary btn-sm"
                                onClick={handleDisplayNameSave}
                                disabled={!isDisplayNameDirty || updateRepo.isPending}
                            >
                                Save Name
                            </button>
                            <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={handleDisplayNameReset}
                                disabled={(!normalizedDraftDisplayName && !currentRepo.displayName) || updateRepo.isPending}
                            >
                                Reset
                            </button>
                        </div>
                    </div>
                </div>

                <div className="card bg-base-100 shadow-xl border border-base-200">
                    <div className="card-body">
                        <h2 className="card-title">Repository Credentials</h2>
                        <p className="text-sm opacity-70">
                            Associate a credential with this repository to authenticate with remote servers.
                        </p>

                        <div className="form-control w-full mt-4">
                            <label className="label">
                                <span className="label-text">Associated Credential</span>
                            </label>
                            <select
                                className="select select-bordered w-full"
                                value={currentRepo.credentialId || 'none'}
                                onChange={handleCredentialChange}
                            >
                                <option value="none">None</option>
                                {matchingCredentials.map((cred) => (
                                    <option key={cred.id} value={cred.id}>
                                        {cred.type === 'github' ? 'GitHub' : 'GitLab'}
                                        {cred.type === 'gitlab' && ` (${new URL(cred.serverUrl!).hostname})`}
                                        {' - '}
                                        {cred.type === 'github' ? 'Account' : 'Token'}
                                    </option>
                                ))}
                            </select>
                            {matchingCredentials.length === 0 && (
                                <label className="label">
                                    <span className="label-text-alt opacity-70">
                                        No matching credentials found for this repository&apos;s remotes.
                                        Add credentials in the Credentials page.
                                    </span>
                                </label>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default function WorkspaceSettingsPage() {
    return (
        <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="loading loading-spinner"></span></div>}>
            <WorkspaceSettingsContent />
        </Suspense>
    );
}
