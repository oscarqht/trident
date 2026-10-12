import { NextResponse } from 'next/server';
import { getDesktopStatus, toggleAutostart, openFullDiskAccessSettings } from '@/lib/desktop';
import { z } from 'zod';

export async function GET() {
  const status = getDesktopStatus();
  return NextResponse.json(status);
}

const desktopActionSchema = z.object({
  action: z.enum(['toggle-autostart', 'open-full-disk-access']),
});

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action } = desktopActionSchema.parse(body);

    if (action === 'toggle-autostart') {
      const autostartEnabled = await toggleAutostart();
      const status = getDesktopStatus();
      return NextResponse.json({ ...status, autostartEnabled });
    }

    if (action === 'open-full-disk-access') {
      await openFullDiskAccessSettings();
      const status = getDesktopStatus();
      return NextResponse.json(status);
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
