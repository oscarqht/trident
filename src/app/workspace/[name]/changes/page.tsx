'use client';

import { useSearchParams, useRouter, useParams } from 'next/navigation';
import { useEffect, Suspense } from 'react';

function WorkspaceChangesRedirect() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { name } = useParams<{ name: string }>();

  useEffect(() => {
    const params = searchParams.toString();
    const base = `/workspace/${name}`;
    router.replace(params ? `${base}?${params}` : base);
  }, [router, searchParams, name]);

  return (
    <div className="flex items-center justify-center h-full">
      <span className="loading loading-spinner"></span>
    </div>
  );
}

export default function WorkspaceChangesPage() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-full"><span className="loading loading-spinner"></span></div>}>
      <WorkspaceChangesRedirect />
    </Suspense>
  );
}
