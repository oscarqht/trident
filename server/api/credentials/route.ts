import { NextResponse } from '../../next-shim';
import { z } from 'zod';
import {
  getAllCredentials,
  createGitHubCredential,
  createGitLabCredential,
  updateCredential,
  deleteCredential,
} from '@/lib/credentials';

// GET - List all credentials
export async function GET() {
  try {
    const credentials = await getAllCredentials();
    return NextResponse.json(credentials);
  } catch (error) {
    console.error('Failed to get credentials:', error);
    return NextResponse.json({ error: 'Failed to get credentials' }, { status: 500 });
  }
}

// POST - Create a new credential
const createGitHubSchema = z.object({
  type: z.literal('github'),
  token: z.string().min(1, 'Token is required'),
});

const createGitLabSchema = z.object({
  type: z.literal('gitlab'),
  serverUrl: z.string().url('Invalid server URL'),
  token: z.string().min(1, 'Token is required'),
});

const createSchema = z.discriminatedUnion('type', [createGitHubSchema, createGitLabSchema]);

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const data = createSchema.parse(body);

    let result;
    if (data.type === 'github') {
      result = await createGitHubCredential(data.token);
    } else {
      result = await createGitLabCredential(data.serverUrl, data.token);
    }

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json(result.credential);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0].message }, { status: 400 });
    }
    console.error('Failed to create credential:', error);
    return NextResponse.json({ error: 'Failed to create credential' }, { status: 500 });
  }
}

// PUT - Update a credential
const updateSchema = z.object({
  id: z.string().min(1, 'Credential ID is required'),
  token: z.string().min(1, 'Token is required'),
});

export async function PUT(request: Request) {
  try {
    const body = await request.json();
    const { id, token } = updateSchema.parse(body);

    const result = await updateCredential(id, token);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json(result.credential);
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0].message }, { status: 400 });
    }
    console.error('Failed to update credential:', error);
    return NextResponse.json({ error: 'Failed to update credential' }, { status: 500 });
  }
}

// DELETE - Delete a credential
const deleteSchema = z.object({
  id: z.string().min(1, 'Credential ID is required'),
});

export async function DELETE(request: Request) {
  try {
    const body = await request.json();
    const { id } = deleteSchema.parse(body);

    const result = await deleteCredential(id);

    if (!result.success) {
      return NextResponse.json({ error: result.error }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues[0].message }, { status: 400 });
    }
    console.error('Failed to delete credential:', error);
    return NextResponse.json({ error: 'Failed to delete credential' }, { status: 500 });
  }
}
