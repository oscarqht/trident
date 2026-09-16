import { NextResponse } from '../../../next-shim';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const openFolderSchema = z.object({
  path: z.string().min(1),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { path: requestedPath } = openFolderSchema.parse(body);
    const resolvedPath = path.resolve(requestedPath);

    const stats = await fs.stat(resolvedPath);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    if (process.platform === 'darwin') {
      await execFileAsync('open', [resolvedPath]);
    } else if (process.platform === 'win32') {
      await execFileAsync('explorer.exe', [resolvedPath]);
    } else {
      await execFileAsync('xdg-open', [resolvedPath]);
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
