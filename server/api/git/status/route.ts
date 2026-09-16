import { NextResponse } from '../../../next-shim';
import { GitService } from '@/lib/git';
import { handleGitError } from '@/lib/api-utils';
import fs from 'node:fs/promises';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get('path');

  if (!path) {
    return NextResponse.json({ error: 'Repo path is required' }, { status: 400 });
  }

  // Check if path exists
  try {
    await fs.access(path);
  } catch {
    return NextResponse.json({ error: `Path not found: ${path}` }, { status: 404 });
  }

  try {
    const git = new GitService(path);
    const status = await git.getStatus();
    return NextResponse.json(status);
  } catch (error) {
    return handleGitError(error);
  }
}
