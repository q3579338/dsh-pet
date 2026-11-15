/** 有界、可取消的 WorkBuddy 运行管道；凭据和任意 stderr 从不返回给页面。 */
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { WorkBuddyFailure, type WorkBuddyCommand } from './executable.ts';

/** 请求正文通过标准输入传输；每次退出、取消、超限都释放自己创建的进程。 */
export async function* runWorkBuddy(
  command: WorkBuddyCommand,
  args: string[],
  cwd: string,
  input: string,
  signal: AbortSignal,
  timeoutMs: number,
): AsyncGenerator<string> {
  if (signal.aborted) throw new WorkBuddyFailure('WorkBuddy 回复已停止。');
  const child = spawn(command.file, [...command.args, ...args], {
    cwd,
    env: command.env,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let failed = false,
    timedOut = false,
    stderrSize = 0;
  const exited = new Promise<number | null>((done) => {
    child.once('error', () => {
      failed = true;
    });
    child.once('close', done);
  });
  child.stdin.on('error', () => {});
  const stop = (): void => {
    child.kill();
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  signal.addEventListener('abort', stop, { once: true });
  child.stderr.on('data', (data: Buffer) => {
    stderrSize += data.length;
    if (stderrSize > 65536) stop();
  });
  child.stdin.end(input);
  const decoder = new StringDecoder('utf8');
  let bytes = 0;
  try {
    for await (const chunk of child.stdout) {
      if (signal.aborted) throw new WorkBuddyFailure('WorkBuddy 回复已停止。');
      bytes += (chunk as Buffer).length;
      if (bytes > 4 * 1024 * 1024) throw new WorkBuddyFailure('WorkBuddy 返回内容过大，已停止。');
      yield decoder.write(chunk as Buffer);
    }
    const tail = decoder.end();
    if (tail) yield tail;
    const code = await exited;
    if (signal.aborted) throw new WorkBuddyFailure('WorkBuddy 回复已停止。');
    if (timedOut) throw new WorkBuddyFailure('WorkBuddy 回复超时，请稍后重试。');
    if (failed || code !== 0 || stderrSize > 65536)
      throw new WorkBuddyFailure('WorkBuddy 未能完成请求，请检查登录与模型。');
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', stop);
    if (child.exitCode === null) stop();
    child.stdout.destroy();
    child.stderr.destroy();
    child.stdin.destroy();
    void exited;
  }
}
