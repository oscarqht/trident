import { NextResponse } from '../../next-shim';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const requestedPath = searchParams.get('path');

  // Default to home directory
  const currentPath = requestedPath ? requestedPath : os.homedir();

  try {
      // Security check: though this is local app, basic sanity check
      // For now, allow reading anywhere as it's a dev tool/local tool.
      
      const stats = await fs.promises.stat(currentPath);
      if (!stats.isDirectory()) {
          return NextResponse.json({ error: 'Not a directory' }, { status: 400 });
      }

      const items = await fs.promises.readdir(currentPath, { withFileTypes: true });
      
      // Check whether the current folder is itself a git repo.
      let isRepo = false;
      try {
        await fs.promises.access(path.join(currentPath, '.git'), fs.constants.F_OK);
        isRepo = true;
      } catch {}

      // Let's verify if child folders are git repos.
      const directories = items.filter(item => item.isDirectory());

      const contents = [];
      const BATCH_SIZE = 50;

      for (let i = 0; i < directories.length; i += BATCH_SIZE) {
          const batch = directories.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(batch.map(async (item) => {
              const itemPath = path.join(currentPath, item.name);
              let isRepo = false;
              try {
                  // Check for .git directory inside
                  await fs.promises.access(path.join(itemPath, '.git'), fs.constants.F_OK);
                  isRepo = true;
              } catch {}

              return {
                  name: item.name,
                  path: itemPath,
                  isRepo
              };
          }));
          contents.push(...batchResults);
      }

      // Sort: Visible folders first, then Repos first within that group, then alphabetical
      contents.sort((a, b) => {
          const aHidden = a.name.startsWith('.');
          const bHidden = b.name.startsWith('.');

          // Visible first
          if (!aHidden && bHidden) return -1;
          if (aHidden && !bHidden) return 1;

          // Repos first
          if (a.isRepo && !b.isRepo) return -1;
          if (!a.isRepo && b.isRepo) return 1;

          return a.name.localeCompare(b.name);
      });

      return NextResponse.json({
          path: currentPath,
          isRepo,
          folders: contents,
          parent: path.dirname(currentPath)
      });
      
  } catch (error) {
      return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const rawParentPath = typeof body?.path === 'string' ? body.path : '';
    const rawFolderName = typeof body?.name === 'string' ? body.name : '';

    const parentPath = rawParentPath.trim();
    const folderName = rawFolderName.trim();

    if (!parentPath) {
      return NextResponse.json({ error: 'Path is required' }, { status: 400 });
    }
    if (!folderName) {
      return NextResponse.json({ error: 'Folder name is required' }, { status: 400 });
    }
    if (folderName === '.' || folderName === '..') {
      return NextResponse.json({ error: 'Invalid folder name' }, { status: 400 });
    }
    if (folderName.includes('/') || folderName.includes('\\') || path.basename(folderName) !== folderName) {
      return NextResponse.json({ error: 'Folder name cannot include path separators' }, { status: 400 });
    }

    const parentStat = await fs.promises.stat(parentPath);
    if (!parentStat.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    const folderPath = path.join(parentPath, folderName);

    if (fs.existsSync(folderPath)) {
      return NextResponse.json({ error: 'Folder already exists' }, { status: 400 });
    }

    await fs.promises.mkdir(folderPath);

    return NextResponse.json({
      path: folderPath,
      name: folderName,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
