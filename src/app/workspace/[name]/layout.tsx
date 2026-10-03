'use client';

import { useEffect, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useAddRepository, useCurrentRepo } from '@/hooks/use-git';
import { FileSystemBrowser } from '@/components/fs-browser';
import { toast } from '@/hooks/use-toast';

function Spinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <span className="loading loading-spinner"></span>
    </div>
  );
}

function ProjectNotFound({ name }: { name: string }) {
  const addRepo = useAddRepository();
  const [browserOpen, setBrowserOpen] = useState(false);

  const handleSelect = async (path: string, meta: { isRepo: boolean }) => {
    if (!meta.isRepo) {
      toast({
        type: 'error',
        title: 'Not a git repository',
        description: 'Select the folder of an existing git repository.',
      });
      return;
    }
    try {
      await addRepo.mutateAsync({ path, name });
      setBrowserOpen(false);
    } catch (error) {
      toast({
        type: 'error',
        title: 'Failed to register project',
        description: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  return (
    <div className="p-8 max-w-xl mx-auto space-y-4">
      <h1 className="text-xl font-bold tracking-tight">Project &ldquo;{name}&rdquo; not found</h1>
      <p className="text-sm text-base-content/70">
        No project with this name is registered on this machine. If it lives in a different
        folder here, locate it and it will be registered as <span className="font-mono">{name}</span>.
      </p>
      <div className="flex items-center gap-2">
        <button className="btn btn-primary btn-sm" onClick={() => setBrowserOpen(true)} disabled={addRepo.isPending}>
          Locate folder
        </button>
        <Link href="/" className="btn btn-ghost btn-sm">All repositories</Link>
      </div>
      <FileSystemBrowser
        open={browserOpen}
        onOpenChange={setBrowserOpen}
        onSelect={handleSelect}
        title={`Locate "${name}"`}
      />
    </div>
  );
}

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { name, repo, isLoading } = useCurrentRepo();

  // URL matching is case-insensitive; redirect to the canonical casing.
  const needsCanonicalRedirect = !!repo && !!name && repo.name !== name;
  useEffect(() => {
    if (!needsCanonicalRedirect || !repo) return;
    const segments = pathname.split('/');
    segments[2] = encodeURIComponent(repo.name);
    router.replace(`${segments.join('/')}${window.location.search}`);
  }, [needsCanonicalRedirect, repo, pathname, router]);

  if (isLoading || needsCanonicalRedirect) return <Spinner />;
  if (!repo || !name) return <ProjectNotFound name={name ?? ''} />;
  return <>{children}</>;
}
