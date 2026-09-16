
import { NextResponse } from 'next/server';
import { getRepositories, addRepository, updateRepository, removeRepository } from '@/lib/store';
import { GitService } from '@/lib/git';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';

const customScriptSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  target: z.literal('branch'),
  action: z.literal('run-bash-script'),
  content: z.string(),
});

export async function GET() {
  const repos = getRepositories();
  return NextResponse.json(repos);
}

const addRepoSchema = z.object({
  path: z.string().min(1),
  name: z.string().optional(),
  displayName: z.string().nullable().optional(),
  initializeIfNeeded: z.boolean().optional().default(false),
});

const updateRepoSchema = z.object({
  path: z.string().min(1),
  updates: z.object({
    name: z.string().optional(),
    displayName: z.string().nullable().optional(),
    icon: z.string().nullable().optional(),
    lastOpenedAt: z.string().optional(),
    credentialId: z.string().optional().nullable(),
    customScripts: z.array(customScriptSchema).optional(),
    expandedFolders: z.array(z.string()).optional(),
    visibilityMap: z.record(z.string(), z.enum(['visible', 'hidden'])).optional(),
    localGroupExpanded: z.boolean().optional(),
    remotesGroupExpanded: z.boolean().optional(),
    worktreesGroupExpanded: z.boolean().optional(),
  }),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { path: repoPath, name, displayName, initializeIfNeeded } = addRepoSchema.parse(body);

    if (initializeIfNeeded) {
      const stat = await fs.stat(repoPath);
      if (!stat.isDirectory()) {
        return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
      }

      let isGitRepo = false;
      try {
        await fs.access(path.join(repoPath, '.git'));
        isGitRepo = true;
      } catch {}

      if (!isGitRepo) {
        await GitService.initializeRepository(repoPath);
      }
    }

    const repo = addRepository(repoPath, name, displayName);
    return NextResponse.json(repo);
  } catch (error) {
     if (error instanceof z.ZodError) {
        return NextResponse.json({ error: error.issues }, { status: 400 });
     }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { path, updates } = updateRepoSchema.parse(body);
    const repo = updateRepository(path, updates);
    return NextResponse.json(repo);
  } catch (error) {
     if (error instanceof z.ZodError) {
        return NextResponse.json({ error: error.issues }, { status: 400 });
     }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

const deleteRepoSchema = z.object({
  path: z.string().min(1),
  deleteLocalFolder: z.boolean().optional().default(false),
});

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const { path, deleteLocalFolder } = deleteRepoSchema.parse(body);
    removeRepository(path, { deleteLocalFolder });
    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
