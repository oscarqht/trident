import { NextResponse } from '../../../next-shim';
import { GitService } from '@/lib/git';
import { getImageMimeType, isImageFile } from '@/lib/utils';
import { handleGitError } from '@/lib/api-utils';
import fs from 'node:fs';
import pathLib from 'path';

function toImageSide(buffer: Buffer | null, mimeType: string) {
  if (!buffer) return null;
  return {
    mimeType,
    base64: buffer.toString('base64'),
  };
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const repoPath = searchParams.get('path');
  const filePath = searchParams.get('file');
  const commitHash = searchParams.get('commit');
  const fromCommitHash = searchParams.get('from');
  const toCommitHash = searchParams.get('to');
  const hasSingleCommit = !!commitHash;
  const hasCommitRange = !!fromCommitHash && !!toCommitHash;

  if (!repoPath) {
    return NextResponse.json({ error: 'Repo path is required' }, { status: 400 });
  }

  if ((fromCommitHash && !toCommitHash) || (!fromCommitHash && toCommitHash)) {
    return NextResponse.json({ error: 'Both from and to commit hashes are required for commit range diff' }, { status: 400 });
  }

  if (hasSingleCommit && hasCommitRange) {
    return NextResponse.json({ error: 'Provide either commit or from/to parameters, not both' }, { status: 400 });
  }

  // Check if path exists
  if (!fs.existsSync(repoPath)) {
    return NextResponse.json({ error: `Path not found: ${repoPath}` }, { status: 404 });
  }

  try {
    const git = new GitService(repoPath);

    // If commit hash or commit range is provided, get commit diff
    if (hasSingleCommit || hasCommitRange) {
      // If file path is also provided, get diff for that specific file in the commit / range
      if (filePath) {
        if (isImageFile(filePath)) {
          const mimeType = getImageMimeType(filePath);
          const [beforeBuffer, afterBuffer, diff] = hasSingleCommit
            ? await Promise.all([
                git.getFileContentBuffer(filePath, `${commitHash!}^`),
                git.getFileContentBuffer(filePath, commitHash!),
                git.getCommitFilePatch(commitHash!, filePath),
              ])
            : await (async () => {
                const { fromRef, toRef } = await git.getCommitRangeRefs(fromCommitHash!, toCommitHash!);
                return Promise.all([
                  git.getFileContentBuffer(filePath, fromRef),
                  git.getFileContentBuffer(filePath, toRef),
                  git.getCommitRangeFilePatch(fromCommitHash!, toCommitHash!, filePath),
                ]);
              })();

          return NextResponse.json({
            left: '',
            right: '',
            diff,
            imageDiff: {
              left: toImageSide(beforeBuffer, mimeType),
              right: toImageSide(afterBuffer, mimeType),
            },
          });
        }

        const { before, after, diff } = hasSingleCommit
          ? await git.getCommitFileDiff(commitHash!, filePath)
          : await git.getCommitRangeFileDiff(fromCommitHash!, toCommitHash!, filePath);

        return NextResponse.json({ left: before, right: after, diff });
      }
      
      // Otherwise, get the list of files changed in the commit / range
      const { files, diff } = hasSingleCommit
        ? await git.getCommitDiff(commitHash!)
        : await git.getCommitRangeDiff(fromCommitHash!, toCommitHash!);

      return NextResponse.json({ files, diff });
    }

    // Original behavior: diff against working directory
    if (!filePath) {
      return NextResponse.json({ error: 'File path is required' }, { status: 400 });
    }

    const diff = await git.getDiff(filePath);

    if (isImageFile(filePath)) {
      const mimeType = getImageMimeType(filePath);
      const fullPath = pathLib.join(repoPath, filePath);
      const [leftBuffer, rightBuffer] = await Promise.all([
        git.getFileContentBuffer(filePath, 'HEAD'),
        fs.existsSync(fullPath) ? fs.promises.readFile(fullPath) : Promise.resolve(null),
      ]);

      return NextResponse.json({
        diff,
        left: '',
        right: '',
        imageDiff: {
          left: toImageSide(leftBuffer, mimeType),
          right: toImageSide(rightBuffer, mimeType),
        },
      });
    }

    // Get content for Diff Viewer
    const left = await git.getFileContent(filePath, 'HEAD');
    let right = '';
    const fullPath = pathLib.join(repoPath, filePath);
    if (fs.existsSync(fullPath)) {
      right = await fs.promises.readFile(fullPath, 'utf-8');
    }

    return NextResponse.json({ diff, left, right });
  } catch (error) {
    return handleGitError(error);
  }
}
