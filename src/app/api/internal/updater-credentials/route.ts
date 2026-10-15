import { updaterCredentialsResponse } from '@/lib/updater-credentials.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  return updaterCredentialsResponse(request, {
    secret: process.env.TRIDENT_INTERNAL_TOKEN,
    listCredentials: async () => (await import('@/lib/credentials')).getAllCredentials(),
    getToken: async (id: string) => (await import('@/lib/credentials')).getCredentialToken(id),
  });
}
