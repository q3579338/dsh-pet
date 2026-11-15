/** WorkBuddy 原生流式识别进程；身份只驻留在它自己的运行组件，录音不落盘。 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { nativeWorker } from './worker-path.ts';
import { resolveWorkBuddyCommand, WorkBuddyFailure, type WorkBuddyCommand } from './executable.ts';
import { workBuddyError } from './events.ts';
import type { StreamingDictation } from '../../host/voice/codex/dictation-stream.ts';

export async function createWorkBuddyDictation(
  home: string,
  partial: (text: string) => void,
  signal: AbortSignal,
  deps: { command?: () => WorkBuddyCommand; worker?: string } = {},
): Promise<StreamingDictation> {
  signal.throwIfAborted();
  const command = (deps.command ?? resolveWorkBuddyCommand)(),
    cwd = join(home, 'workbuddy-voice');
  mkdirSync(cwd, { recursive: true });
  const child = spawn(command.file, [...command.args, deps.worker ?? nativeWorker(), '--asr'], {
    cwd,
    env: command.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let closed = false,
    finishing = false,
    completed = false,
    errorBytes = 0,
    outputBytes = 0,
    carry = '';
  let resolveReady!: () => void,
    rejectReady!: (error: Error) => void,
    resolveFinal!: (text: string) => void,
    rejectFinal!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const final = new Promise<string>((resolve, reject) => {
    resolveFinal = resolve;
    rejectFinal = reject;
  });
  void final.catch(() => {});
  const dispose = (error = new WorkBuddyFailure('WorkBuddy 语音识别已停止，请继续说话重试。')): void => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    signal.removeEventListener('abort', abort);
    child.kill();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
    rejectReady(error);
    rejectFinal(error);
  };
  const abort = (): void => dispose();
  let timer = setTimeout(abort, 15000);
  signal.addEventListener('abort', abort, { once: true });
  child.once('error', abort);
  child.once('close', abort);
  child.stdin.on('error', abort);
  child.stderr.on('data', (bytes: Buffer) => {
    errorBytes += bytes.length;
    if (errorBytes > 65536) abort();
  });
  const decoder = new StringDecoder('utf8');
  child.stdout.on('data', (bytes: Buffer) => {
    if (closed) return;
    outputBytes += bytes.length;
    carry += decoder.write(bytes);
    if (outputBytes > 1024 * 1024 || carry.length > 65536) {
      abort();
      return;
    }
    let end: number;
    while ((end = carry.indexOf('\n')) >= 0) {
      try {
        const value = JSON.parse(carry.slice(0, end));
        carry = carry.slice(end + 1);
        if (value.type === 'error') {
          dispose(workBuddyError(value.code));
          return;
        }
        if (value.type === 'asr-ready') {
          clearTimeout(timer);
          timer = setTimeout(abort, 270000);
          resolveReady();
        } else if (value.type === 'asr-partial' && typeof value.text === 'string' && value.text.length <= 16000)
          partial(value.text);
        else if (value.type === 'asr-final' && typeof value.text === 'string' && value.text.length <= 16000) {
          completed = true;
          resolveFinal(value.text.trim());
          dispose();
          return;
        } else if (value.type !== 'asr-ready') {
          abort();
          return;
        }
      } catch {
        abort();
        return;
      }
    }
  });
  if (signal.aborted) dispose();
  try {
    await ready;
  } catch (error) {
    dispose();
    throw error;
  }
  return {
    available: () => !closed && !finishing,
    append(pcm) {
      if (completed) return;
      if (
        closed ||
        finishing ||
        !pcm.length ||
        pcm.length % 2 ||
        pcm.length > 16384 ||
        child.stdin.writableLength > 160000
      )
        throw new WorkBuddyFailure('WorkBuddy 语音连接暂时不可用，请重试。');
      child.stdin.write(JSON.stringify({ type: 'audio', audio: Buffer.from(pcm).toString('base64') }) + '\n');
    },
    finish() {
      if (!closed && !finishing) {
        finishing = true;
        clearTimeout(timer);
        timer = setTimeout(abort, 15000);
        child.stdin.write('{"type":"finish"}\n');
      }
      return final;
    },
    dispose,
  };
}
