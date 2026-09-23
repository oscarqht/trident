import { NextResponse } from 'next/server';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { getAugmentedEnv } from '@/lib/platform-utils';

const execFileAsync = promisify(execFile);

const openTerminalSchema = z.object({
  path: z.string().min(1),
});

async function spawnDetached(command: string, args: string[]) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
      env: getAugmentedEnv(),
    });

    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

async function openTerminalOnLinux(resolvedPath: string) {
  const candidates: Array<{ command: string; args: string[] }> = [
    { command: 'x-terminal-emulator', args: ['--working-directory', resolvedPath] },
    { command: 'gnome-terminal', args: [`--working-directory=${resolvedPath}`] },
    { command: 'konsole', args: ['--workdir', resolvedPath] },
    { command: 'xfce4-terminal', args: ['--working-directory', resolvedPath] },
    { command: 'kitty', args: ['--directory', resolvedPath] },
    { command: 'alacritty', args: ['--working-directory', resolvedPath] },
  ];

  for (const candidate of candidates) {
    try {
      await spawnDetached(candidate.command, candidate.args);
      return;
    } catch {
      // Try next terminal command.
    }
  }

  throw new Error('Unable to find a supported terminal emulator on this system');
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { path: requestedPath } = openTerminalSchema.parse(body);
    const resolvedPath = path.resolve(requestedPath);

    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    if (process.platform === 'darwin') {
      await execFileAsync('open', ['-a', 'Terminal', resolvedPath], { env: getAugmentedEnv() });
    } else if (process.platform === 'win32') {
      await execFileAsync('cmd.exe', ['/c', 'start', '""', '/D', resolvedPath, 'cmd.exe'], { env: getAugmentedEnv() });
    } else {
      await openTerminalOnLinux(resolvedPath);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
