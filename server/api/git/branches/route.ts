import { NextResponse } from '../../../next-shim';
import { GitService } from '@/lib/git';
import { handleGitError } from '@/lib/api-utils';

export async function GET(req: Request) {
    const { searchParams } = new URL(req.url);
    const path = searchParams.get('path');

    if (!path) {
        return NextResponse.json({ error: 'Path is required' }, { status: 400 });
    }

    try {
        const git = new GitService(path);
        const branches = await git.getBranches();
        return NextResponse.json(branches);
    } catch (err) {
        return handleGitError(err);
    }
}
