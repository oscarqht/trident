'use client';

import { Suspense, useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAddRepository, useRepositories } from '@/hooks/use-git';
import { workspaceUrl } from '@/lib/workspace-url';

/**
 * Legacy entry point: /workspace?path=<abs path>. Resolves (or registers) the repo
 * and redirects to /workspace/<name>.
 */
function LegacyWorkspaceRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const repoPath = searchParams.get('path');
  const { data: repositories } = useRepositories();
  const addRepo = useAddRepository();
  const startedRef = useRef(false);

  useEffect(() => {
    if (!repoPath) {
      router.replace('/');
      return;
    }
    if (!repositories || startedRef.current) return;
    startedRef.current = true;

    const existing = repositories.find((repo) => repo.path === repoPath);
    if (existing) {
      router.replace(workspaceUrl(existing.name));
      return;
    }
    addRepo.mutateAsync({ path: repoPath })
      .then((added) => router.replace(workspaceUrl(added.name)))
      .catch(() => router.replace('/'));
  }, [repoPath, repositories, router, addRepo]);

  return (
    <div className="flex items-center justify-center h-full">
      <span className="loading loading-spinner"></span>
    </div>
  );
}

export default function WorkspacePage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="loading loading-spinner"></span></div>}>
      <LegacyWorkspaceRedirect />
    </Suspense>
  );
}
