import { NextResponse } from '../../../../next-shim';
import { z } from 'zod';
import { getCredentialById, getCredentialToken } from '@/lib/credentials';

interface GitHubRepoApiItem {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  updated_at: string;
  html_url: string;
  clone_url: string;
  ssh_url: string;
}

const querySchema = z.object({
  credentialId: z.string().min(1, 'Credential ID is required'),
});

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const { credentialId } = querySchema.parse({
      credentialId: searchParams.get('credentialId'),
    });

    const credential = await getCredentialById(credentialId);
    if (!credential) {
      return NextResponse.json({ error: 'Credential not found' }, { status: 404 });
    }
    if (credential.type !== 'github') {
      return NextResponse.json({ error: 'Selected credential is not a GitHub credential' }, { status: 400 });
    }

    const token = await getCredentialToken(credential.id);
    if (!token) {
      return NextResponse.json({ error: 'Token not found for selected credential' }, { status: 400 });
    }

    const response = await fetch('https://api.github.com/user/repos?sort=updated&direction=desc&per_page=100&type=all', {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });

    if (!response.ok) {
      if (response.status === 401) {
        return NextResponse.json({ error: 'Invalid or expired GitHub token' }, { status: 401 });
      }
      return NextResponse.json({ error: `GitHub API error: ${response.status}` }, { status: 502 });
    }

    const repositories = (await response.json()) as GitHubRepoApiItem[];
    const payload = repositories.map((repo) => ({
      id: repo.id,
      name: repo.name,
      fullName: repo.full_name,
      private: repo.private,
      updatedAt: repo.updated_at,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      sshUrl: repo.ssh_url,
    }));

    return NextResponse.json(payload);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0].message }, { status: 400 });
    }
    console.error('Failed to list GitHub repositories:', error);
    return NextResponse.json({ error: 'Failed to list GitHub repositories' }, { status: 500 });
  }
}
