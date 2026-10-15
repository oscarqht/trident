import { timingSafeEqual } from 'node:crypto';

const GITLAB_ORIGIN = 'https://git.insea.io';

/** @param {string | undefined} serverUrl */
export function isUpdaterCredentialServer(serverUrl) {
  try {
    const url = new URL(serverUrl ?? '');
    return url.origin === GITLAB_ORIGIN && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash;
  } catch {
    return false;
  }
}

/**
 * Only the native process knows the per-launch secret. Never expose saved tokens to browser callers.
 * @param {Request} request
 * @param {{secret?: string, listCredentials: () => Promise<import('./credentials').Credential[]>, getToken: (id: string) => Promise<string | null>}} dependencies
 */
export async function updaterCredentialsResponse(request, { secret, listCredentials, getToken }) {
  const reply = (body, status = 200) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
  const supplied = request.headers.get('x-trident-token') ?? '';
  const expectedBytes = Buffer.from(secret ?? '');
  const suppliedBytes = Buffer.from(supplied);
  if (!secret || request.headers.has('origin') || expectedBytes.length !== suppliedBytes.length || !timingSafeEqual(expectedBytes, suppliedBytes)) {
    return reply({ error: 'Forbidden' }, 403);
  }
  try {
    const credentials = (await listCredentials())
      .filter((credential) => credential.type === 'gitlab' && isUpdaterCredentialServer(credential.serverUrl))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    for (const credential of credentials) {
      const token = (await getToken(credential.id))?.trim();
      if (token) return reply({ token });
    }
    return reply({ token: null });
  } catch {
    return reply({ error: 'Could not load update credentials' }, 503);
  }
}
