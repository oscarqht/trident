
import { NextResponse } from '../../next-shim';
import { getSettings, updateSettings, getDefaultRootFolder } from '@/lib/store';
import { z } from 'zod';

export async function GET() {
  const settings = getSettings();
  const resolvedDefaultFolder = getDefaultRootFolder();
  return NextResponse.json({
    ...settings,
    resolvedDefaultFolder, // The actual folder that will be used (after fallback logic)
  });
}

const updateSettingsSchema = z.object({
  defaultRootFolder: z.string().nullable().optional(),
  sidebarCollapsed: z.boolean().optional(),
  historyPanelHeight: z.number().optional(),
});

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const updates = updateSettingsSchema.parse(body);
    const settings = updateSettings(updates);
    const resolvedDefaultFolder = getDefaultRootFolder();
    return NextResponse.json({
      ...settings,
      resolvedDefaultFolder,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
