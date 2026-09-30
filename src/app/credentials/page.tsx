'use client';

import { useRef, useState } from 'react';
import { useCredentials, useCreateCredential, useUpdateCredential, useDeleteCredential } from '@/hooks/use-credentials';
import type { Credential, GitLabCredential } from '@/hooks/use-credentials';
import Image from 'next/image';
import Link from 'next/link';
import { ThemeToggle } from '@/components/theme-toggle';
import { useEscapeDismiss } from '@/hooks/use-escape-dismiss';

type CredentialFormType = 'github' | 'gitlab' | null;
type ProviderType = 'github' | 'gitlab';

const PROVIDER_ICON_URLS: Record<ProviderType, string> = {
  github: 'https://www.google.com/s2/favicons?domain=github.com&sz=64',
  gitlab: 'https://www.google.com/s2/favicons?domain=gitlab.com&sz=64',
};

function ProviderIcon({
  type,
  size,
  className = '',
}: {
  type: ProviderType;
  size: number;
  className?: string;
}) {
  const label = type === 'github' ? 'GitHub' : 'GitLab';
  return (
    <Image
      src={PROVIDER_ICON_URLS[type]}
      alt={`${label} icon`}
      width={size}
      height={size}
      className={className}
      unoptimized
    />
  );
}

export default function CredentialsPage() {
  const { data: credentials, isLoading, error } = useCredentials();
  const createCredential = useCreateCredential();
  const updateCredential = useUpdateCredential();
  const deleteCredential = useDeleteCredential();

  const [formType, setFormType] = useState<CredentialFormType>(null);
  const [editingCredential, setEditingCredential] = useState<Credential | null>(null);
  const [deletingCredential, setDeletingCredential] = useState<Credential | null>(null);

  // Form state
  const [token, setToken] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const credentialFormRef = useRef<HTMLFormElement | null>(null);

  const resetForm = () => {
    setFormType(null);
    setEditingCredential(null);
    setToken('');
    setServerUrl('');
    setShowToken(false);
    setFormError(null);
  };

  const handleOpenCreate = (type: CredentialFormType) => {
    resetForm();
    setFormType(type);
  };

  const handleOpenEdit = (credential: Credential) => {
    setEditingCredential(credential);
    setFormType(credential.type);
    setToken('');
    if (credential.type === 'gitlab') {
      setServerUrl(credential.serverUrl);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    try {
      if (editingCredential) {
        await updateCredential.mutateAsync({ id: editingCredential.id, token });
      } else if (formType === 'github') {
        await createCredential.mutateAsync({ type: 'github', token });
      } else if (formType === 'gitlab') {
        await createCredential.mutateAsync({ type: 'gitlab', serverUrl, token });
      }
      resetForm();
    } catch (err) {
      setFormError((err as Error).message);
    }
  };

  const handleDelete = async () => {
    if (!deletingCredential) return;
    try {
      await deleteCredential.mutateAsync(deletingCredential.id);
      setDeletingCredential(null);
    } catch (err) {
      console.error('Failed to delete credential:', err);
    }
  };

  const isSubmitting = createCredential.isPending || updateCredential.isPending;
  useEscapeDismiss(formType !== null, resetForm, () => {
    if (isSubmitting) {
      return;
    }
    credentialFormRef.current?.requestSubmit();
  });
  useEscapeDismiss(deletingCredential !== null, () => setDeletingCredential(null), () => {
    if (!deletingCredential || deleteCredential.isPending) {
      return;
    }
    void handleDelete();
  });

  return (
    <main className="min-h-screen bg-base-100 flex flex-col">
      <div className="w-full max-w-5xl mx-auto px-6 py-6 flex flex-col gap-6 flex-1">
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-base-300">
          <div className="flex items-center gap-3">
            <Link href="/" className="btn btn-ghost btn-sm btn-square">
              <i className="iconoir-arrow-left text-[18px]" aria-hidden="true" />
            </Link>
            <div>
              <h1 className="text-xl font-bold tracking-tight text-base-content leading-none">Credentials</h1>
              <p className="text-xs text-base-content/60 mt-1">
                Manage your remote repository credentials
              </p>
            </div>
          </div>
          <ThemeToggle />
        </div>

        {/* Add Credential Buttons */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div
            className="border border-base-300 rounded-lg p-4 bg-base-100 hover:border-primary/50 transition-colors cursor-pointer group flex flex-col justify-between"
            onClick={() => handleOpenCreate('github')}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-base-200/60 rounded-md shrink-0">
                <ProviderIcon type="github" size={22} className="h-5.5 w-5.5 rounded-xs" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-base-content group-hover:text-primary transition-colors">GitHub</h3>
                <p className="text-xs text-base-content/60">
                  Personal Access Token
                </p>
              </div>
            </div>
            <button className="btn btn-sm btn-ghost border border-base-300 w-full gap-1.5 text-xs">
              <i className="iconoir-plus text-[15px]" aria-hidden="true" />
              Add GitHub
            </button>
          </div>

          <div
            className="border border-base-300 rounded-lg p-4 bg-base-100 hover:border-primary/50 transition-colors cursor-pointer group flex flex-col justify-between"
            onClick={() => handleOpenCreate('gitlab')}
          >
            <div className="flex items-center gap-3 mb-3">
              <div className="p-2 bg-base-200/60 rounded-md shrink-0">
                <ProviderIcon type="gitlab" size={22} className="h-5.5 w-5.5 rounded-xs" />
              </div>
              <div>
                <h3 className="font-semibold text-sm text-base-content group-hover:text-primary transition-colors">GitLab</h3>
                <p className="text-xs text-base-content/60">Server URL + Personal Access Token</p>
              </div>
            </div>
            <button className="btn btn-sm btn-ghost border border-base-300 w-full gap-1.5 text-xs">
              <i className="iconoir-plus text-[15px]" aria-hidden="true" />
              Add GitLab Server
            </button>
          </div>
        </div>

        {/* Credentials List */}
        <div className="border border-base-300 rounded-lg overflow-hidden bg-base-100">
          <div className="px-4 py-2.5 bg-base-200/50 border-b border-base-300">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-base-content/60">Saved Credentials</h2>
          </div>

          {isLoading ? (
            <div className="p-12 text-center opacity-70">
              <span className="loading loading-spinner"></span>
              <p className="mt-2 text-sm">Loading credentials...</p>
            </div>
          ) : error ? (
            <div className="p-12 text-center text-error">
              <p>Failed to load credentials</p>
            </div>
          ) : credentials?.length === 0 ? (
            <div className="p-12 text-center opacity-50">
              <i className="iconoir-key text-[40px] mx-auto" aria-hidden="true" />
              <p className="font-bold mt-2">No credentials saved yet.</p>
              <p className="text-xs mt-1">Add your first credential using the cards above.</p>
            </div>
          ) : (
            <div className="divide-y divide-base-200">
              {credentials?.map((credential) => (
                <CredentialItem
                  key={credential.id}
                  credential={credential}
                  onEdit={() => handleOpenEdit(credential)}
                  onDelete={() => setDeletingCredential(credential)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Create/Edit Dialog */}
      {formType !== null && (
        <dialog className="modal modal-open">
            <div className="modal-box">
                <h3 className="font-bold text-lg flex items-center gap-2">
                    {formType === 'github' ? (
                      <>
                        <ProviderIcon type="github" size={20} className="h-5 w-5 rounded-sm" />
                        GitHub Credential
                      </>
                    ) : (
                      <>
                        <ProviderIcon type="gitlab" size={20} className="h-5 w-5 rounded-sm" />
                        GitLab Credential
                      </>
                    )}
                </h3>
                <p className="py-4 text-sm opacity-70">
                    {editingCredential
                        ? 'Enter a new personal access token to update this credential.'
                        : formType === 'github'
                        ? 'Enter your GitHub personal access token. This will be stored securely in your system keychain.'
                        : 'Enter your GitLab server URL and personal access token.'}
                </p>

                <form ref={credentialFormRef} onSubmit={handleSubmit} className="flex flex-col gap-4">
                    {formType === 'gitlab' && !editingCredential && (
                        <div className="form-control w-full">
                            <label className="label"><span className="label-text">Server URL</span></label>
                            <input
                                type="url"
                                placeholder="https://gitlab.example.com"
                                value={serverUrl}
                                onChange={(e) => setServerUrl(e.target.value)}
                                required
                                className="input input-bordered w-full"
                                autoFocus
                            />
                            <label className="label"><span className="label-text-alt opacity-70">Enter the full URL of your GitLab server</span></label>
                        </div>
                    )}

                    {formType === 'gitlab' && editingCredential && (
                        <div className="form-control w-full">
                            <label className="label"><span className="label-text">Server URL</span></label>
                            <div className="p-3 bg-base-200 rounded-lg text-sm font-mono flex items-center gap-2 min-w-0 break-all">
                                <ProviderIcon type="gitlab" size={16} className="h-4 w-4 shrink-0 rounded-sm" />
                                {(editingCredential as GitLabCredential).serverUrl}
                            </div>
                        </div>
                    )}

                    <div className="form-control w-full">
                        <label className="label"><span className="label-text">Personal Access Token</span></label>
                        <div className="relative">
                            <input
                                type={showToken ? 'text' : 'password'}
                                placeholder={editingCredential ? 'Enter new token' : 'ghp_xxxxxxxxxxxx or glpat-xxxxx'}
                                value={token}
                                onChange={(e) => setToken(e.target.value)}
                                className="input input-bordered w-full pr-10"
                                required
                                autoFocus={!(formType === 'gitlab' && !editingCredential)}
                            />
                            <button
                                type="button"
                                className="absolute right-2 top-2 btn btn-ghost btn-xs btn-square"
                                onClick={() => setShowToken(!showToken)}
                            >
                                {showToken ? <i className="iconoir-eye-closed text-[16px]" aria-hidden="true" /> : <i className="iconoir-eye text-[16px]" aria-hidden="true" />}
                            </button>
                        </div>
                        <label className="label">
                            <span className="label-text-alt opacity-70">
                                {formType === 'github' ? (
                                    <>
                                    Token needs repo scope.{' '}
                                    <a
                                        href="https://github.com/settings/tokens/new?description=Trident&scopes=repo,user,notifications,workflow"
                                        target="_blank"
                                        rel="noreferrer"
                                        className="link link-primary"
                                    >
                                        Create new token
                                    </a>
                                    </>
                                ) : (
                                    'Token needs api scope for GitLab access'
                                )}
                            </span>
                        </label>
                    </div>

                    {formError && (
                        <div className="alert alert-error text-sm">
                            <span>{formError}</span>
                        </div>
                    )}

                    <div className="modal-action">
                        <button type="button" className="btn" onClick={resetForm} disabled={isSubmitting}>Cancel</button>
                        <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
                            {isSubmitting && <span className="loading loading-spinner loading-xs"></span>}
                            {editingCredential ? 'Update' : 'Verify & Save'}
                        </button>
                    </div>
                </form>
            </div>
            <form method="dialog" className="modal-backdrop">
                <button onClick={resetForm}>close</button>
            </form>
        </dialog>
      )}

      {/* Delete Confirmation Dialog */}
      {deletingCredential !== null && (
        <dialog className="modal modal-open">
            <div className="modal-box">
                <h3 className="font-bold text-lg">Delete Credential</h3>
                <p className="py-4 break-words">
                    Are you sure you want to delete this {deletingCredential?.type === 'github' ? 'GitHub' : 'GitLab'}{' '}
                    credential for <strong className="break-all">{deletingCredential?.username}</strong>? This action cannot be undone.
                </p>
                <div className="modal-action">
                    <button className="btn" onClick={() => setDeletingCredential(null)}>Cancel</button>
                    <button className="btn btn-error" onClick={handleDelete} disabled={deleteCredential.isPending}>
                        {deleteCredential.isPending && <span className="loading loading-spinner loading-xs"></span>}
                        Delete
                    </button>
                </div>
            </div>
            <form method="dialog" className="modal-backdrop">
                <button onClick={() => setDeletingCredential(null)}>close</button>
            </form>
        </dialog>
      )}
    </main>
  );
}

function CredentialItem({
  credential,
  onEdit,
  onDelete,
}: {
  credential: Credential;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const isGitLab = credential.type === 'gitlab';

  return (
    <div className="px-6 py-4 flex items-center justify-between hover:bg-base-200/30 transition-colors">
      <div className="flex items-center gap-4">
        <div className="p-2 bg-base-200 rounded-lg">
          {isGitLab ? (
            <ProviderIcon type="gitlab" size={20} className="h-5 w-5 rounded-sm" />
          ) : (
            <ProviderIcon type="github" size={20} className="h-5 w-5 rounded-sm" />
          )}
        </div>
        <div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-sm">{isGitLab ? 'GitLab' : 'GitHub'}</span>
            {isGitLab && (
              <span className="text-xs opacity-70 font-mono bg-base-200 px-1.5 py-0.5 rounded">
                {(credential as GitLabCredential).serverUrl.replace(/^https?:\/\//, '')}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs opacity-70 mt-1">
            <span className="flex items-center gap-1">
              <i className="iconoir-user text-[14px]" aria-hidden="true" />
              {credential.username}
            </span>
            <span className="flex items-center gap-1">
              <i className="iconoir-calendar text-[14px]" aria-hidden="true" />
              {new Date(credential.updatedAt).toLocaleDateString()}
            </span>
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1">
        <button className="btn btn-ghost btn-sm btn-square" onClick={onEdit} title="Edit">
          <i className="iconoir-edit-pencil text-[16px]" aria-hidden="true" />
        </button>
        <button
          className="btn btn-ghost btn-sm btn-square text-error hover:bg-error/10"
          onClick={onDelete}
          title="Delete"
        >
          <i className="iconoir-trash text-[16px]" aria-hidden="true" />
        </button>
      </div>
    </div>
  );
}
