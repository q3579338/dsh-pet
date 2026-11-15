/** 只在连续语音期间保留自己的后台运行组件，复用连接；取消时杀掉自己持有的子进程。 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { WorkBuddyFailure, type WorkBuddyCommand } from './executable.ts';

/** 父进程只解析有界事件，身份仍由 WorkBuddy 逐次读取。 */
export function createWorkBuddySession(
  command: () => WorkBuddyCommand,
  worker: string,
  cwd: string,
): {
  run(input: unknown, signal: AbortSignal): AsyncIterable<string>;
  dispose(): void;
} {
  type Request = { id: number; lines: string[]; wake?: () => void; done: boolean; error?: Error; bytes: number };
  let child: ChildProcessWithoutNullStreams | undefined,
    active: Request | undefined,
    sequence = 0,
    disposed = false;
  const reset = (): void => {
    const old = child;
    child = undefined;
    if (old) {
      old.kill();
      old.stdin.destroy();
      old.stdout.destroy();
      old.stderr.destroy();
    }
    if (active && !active.done) {
      active.error = new WorkBuddyFailure('WorkBuddy 语音连接已停止，请继续说话重试。');
      active.done = true;
      active.wake?.();
    }
  };
  const start = (): ChildProcessWithoutNullStreams => {
    if (child) return child;
    const target = command();
    const next = spawn(target.file, [...target.args, worker, '--session'], {
      cwd,
      env: target.env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = next;
    const decoder = new StringDecoder('utf8');
    let carry = '',
      errors = 0;
    const failed = (): void => {
      if (child === next) reset();
    };
    next.once('error', failed);
    next.once('close', failed);
    next.stdin.on('error', failed);
    next.stderr.on('data', (bytes: Buffer) => {
      errors += bytes.length;
      if (errors > 65536) failed();
    });
    next.stdout.on('data', (bytes: Buffer) => {
      if (child !== next) return;
      const request = active;
      if (!request || (request.bytes += bytes.length) > 4 * 1024 * 1024) {
        failed();
        return;
      }
      carry += decoder.write(bytes);
      if (carry.length > 1024 * 1024) {
        failed();
        return;
      }
      let end: number;
      while ((end = carry.indexOf('\n')) >= 0) {
        const line = carry.slice(0, end);
        carry = carry.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          if (frame.id !== request.id || !frame.event || request.done) throw Error();
          request.lines.push(JSON.stringify(frame.event));
          if (request.lines.length > 4096) throw Error();
          if (frame.event.type === 'done' || frame.event.type === 'error') request.done = true;
          request.wake?.();
        } catch {
          failed();
          return;
        }
      }
    });
    return next;
  };
  return {
    async *run(input, signal) {
      if (disposed || signal.aborted) throw new WorkBuddyFailure('WorkBuddy 语音已停止。');
      if (active) throw new WorkBuddyFailure('WorkBuddy 正在回复，请稍后继续。');
      const request: Request = { id: ++sequence, lines: [], done: false, bytes: 0 };
      active = request;
      const abort = (): void => reset();
      signal.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, 60000);
      let complete = false;
      try {
        const process = start();
        const line = JSON.stringify({ id: request.id, input });
        if (line.length > 262144) throw new WorkBuddyFailure('语音对话过长，请重新开始。');
        process.stdin.write(line + '\n');
        while (true) {
          if (signal.aborted) throw new WorkBuddyFailure('WorkBuddy 回复已停止。');
          if (request.error) throw request.error;
          const line = request.lines.shift();
          if (line !== undefined) yield line;
          else if (request.done) {
            complete = true;
            break;
          } else
            await new Promise<void>((resolve) => {
              request.wake = resolve;
            });
        }
      } finally {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        if (!complete) reset();
        if (active === request) active = undefined;
      }
    },
    dispose() {
      disposed = true;
      reset();
    },
  };
}
