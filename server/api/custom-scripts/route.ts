import { NextResponse } from '../../next-shim';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import { z } from 'zod';
import { GitService } from '@/lib/git';

export const runtime = 'nodejs';

type ExecutionStatus = 'running' | 'completed' | 'failed' | 'canceled';

interface ScriptExecution {
  id: string;
  status: ExecutionStatus;
  cancelRequested: boolean;
  output: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  startedAt: string;
  finishedAt: string | null;
  process: ChildProcessWithoutNullStreams | null;
}

const executions = new Map<string, ScriptExecution>();
const MAX_OUTPUT_LENGTH = 500_000;
const FINISHED_EXECUTION_TTL_MS = 30 * 60 * 1000;

const startSchema = z.object({
  command: z.literal('start'),
  repoPath: z.string().min(1),
  branchRef: z.string().min(1),
  scriptContent: z.string(),
});

const statusSchema = z.object({
  command: z.literal('status'),
  executionId: z.string().min(1),
});

const cancelSchema = z.object({
  command: z.literal('cancel'),
  executionId: z.string().min(1),
});

const requestSchema = z.discriminatedUnion('command', [startSchema, statusSchema, cancelSchema]);

function normalizeBranchForCheckout(branchRef: string): string {
  return branchRef.startsWith('remotes/') ? branchRef.slice('remotes/'.length) : branchRef;
}

function appendOutput(execution: ScriptExecution, text: string) {
  execution.output += text;
  if (execution.output.length > MAX_OUTPUT_LENGTH) {
    execution.output = execution.output.slice(execution.output.length - MAX_OUTPUT_LENGTH);
  }
}

function toResponsePayload(execution: ScriptExecution) {
  return {
    executionId: execution.id,
    status: execution.status,
    cancelRequested: execution.cancelRequested,
    output: execution.output,
    exitCode: execution.exitCode,
    signal: execution.signal,
    startedAt: execution.startedAt,
    finishedAt: execution.finishedAt,
  };
}

function cleanupFinishedExecutions() {
  const now = Date.now();
  for (const [id, execution] of executions.entries()) {
    if (execution.status === 'running') continue;
    if (!execution.finishedAt) continue;
    const finishedAtMs = new Date(execution.finishedAt).getTime();
    if (Number.isNaN(finishedAtMs)) continue;
    if (now - finishedAtMs > FINISHED_EXECUTION_TTL_MS) {
      executions.delete(id);
    }
  }
}

export async function POST(request: Request) {
  try {
    cleanupFinishedExecutions();

    const body = await request.json();
    const payload = requestSchema.parse(body);

    if (payload.command === 'status') {
      const execution = executions.get(payload.executionId);
      if (!execution) {
        return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
      }

      return NextResponse.json({ success: true, ...toResponsePayload(execution) });
    }

    if (payload.command === 'cancel') {
      const execution = executions.get(payload.executionId);
      if (!execution) {
        return NextResponse.json({ error: 'Execution not found' }, { status: 404 });
      }

      if (execution.status === 'running' && execution.process) {
        execution.cancelRequested = true;
        appendOutput(execution, '\n[info] Cancel requested...\n');
        execution.process.kill('SIGTERM');

        setTimeout(() => {
          if (execution.process && execution.cancelRequested) {
            execution.process.kill('SIGKILL');
          }
        }, 1500);
      }

      return NextResponse.json({ success: true, ...toResponsePayload(execution) });
    }

    const { repoPath, branchRef, scriptContent } = payload;

    if (!fs.existsSync(repoPath)) {
      return NextResponse.json({ error: `Path not found: ${repoPath}` }, { status: 404 });
    }

    if (!fs.statSync(repoPath).isDirectory()) {
      return NextResponse.json({ error: 'Repository path must be a directory' }, { status: 400 });
    }

    const git = new GitService(repoPath);
    const branches = await git.getBranches();
    const checkoutBranch = normalizeBranchForCheckout(branchRef);
    const currentBranch = branches.current;

    if (!currentBranch || currentBranch !== checkoutBranch) {
      await git.checkout(checkoutBranch);
    }

    const executionId = crypto.randomUUID();
    const child = spawn('bash', ['-s'], {
      cwd: repoPath,
      env: process.env,
      stdio: 'pipe',
    });

    const execution: ScriptExecution = {
      id: executionId,
      status: 'running',
      cancelRequested: false,
      output: '',
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      process: child,
    };

    executions.set(executionId, execution);

    const onData = (chunk: Buffer | string) => {
      appendOutput(execution, typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    };

    child.stdout.on('data', onData);
    child.stderr.on('data', onData);

    child.on('error', (error) => {
      appendOutput(execution, `\n[error] ${error.message}\n`);
      execution.status = execution.cancelRequested ? 'canceled' : 'failed';
      execution.finishedAt = new Date().toISOString();
      execution.process = null;
    });

    child.on('close', (code, signal) => {
      execution.exitCode = code;
      execution.signal = signal;
      execution.finishedAt = new Date().toISOString();
      execution.process = null;

      if (execution.cancelRequested) {
        execution.status = 'canceled';
        return;
      }

      execution.status = code === 0 ? 'completed' : 'failed';
    });

    child.stdin.write(scriptContent);
    child.stdin.end();

    return NextResponse.json({
      success: true,
      ...toResponsePayload(execution),
      checkedOutBranch: checkoutBranch,
      previousBranch: currentBranch,
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: error.issues }, { status: 400 });
    }
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }
}
