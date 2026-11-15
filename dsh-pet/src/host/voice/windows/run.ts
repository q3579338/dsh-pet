/** 在隐藏的 Windows PowerShell 中执行固定语音程序；文本和音频只经过 stdin/stdout。 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { SpeechUnavailableError } from '../speech-types.ts';
import { WINDOWS_SPEECH_SCRIPT } from './script.ts';

/** 工作进程有独立超时与取消；不会把输入拼进命令或写入临时文件。 */
export function runWindowsSpeech(
  input: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (process.platform !== 'win32') return Promise.reject(new SpeechUnavailableError('需要 Windows 本机语音服务。'));
  if (signal?.aborted) return Promise.reject(new Error('语音处理已停止。'));
  return new Promise((resolve, reject) => {
    const child = spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(WINDOWS_SPEECH_SCRIPT, 'utf16le').toString('base64'),
      ],
      { windowsHide: true, stdio: 'pipe' },
    );
    let output = '';
    let ended = false;
    const finish = (error?: Error): void => {
      if (ended) return;
      ended = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      if (child.exitCode === null) child.kill();
      if (error) return reject(error);
      try {
        const result: unknown = JSON.parse(output.replace(/^\uFEFF/, '').trim());
        if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
        const record = result as Record<string, unknown>;
        if (record.error === 'no-recognizer')
          return reject(new SpeechUnavailableError('Windows 未安装中文语音识别组件。'));
        if (record.error === 'no-voice')
          return reject(new SpeechUnavailableError('Windows 未安装所选语言的朗读音色。'));
        if (record.error) return reject(new Error('Windows 语音处理失败，请检查录音格式或系统语音组件。'));
        resolve(record);
      } catch {
        reject(new Error('Windows 语音未返回有效结果。'));
      }
    };
    const abort = (): void => finish(new Error('语音处理已停止。'));
    const timeout = setTimeout(() => finish(new Error('Windows 语音处理超时，请缩短录音后重试。')), 40_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.length > 4_000_000) finish(new Error('语音输出过长，请缩短文本后重试。'));
    });
    child.stderr.resume();
    child.once('error', () => finish(new SpeechUnavailableError('无法启动 Windows 本机语音。')));
    child.stdin.on('error', () => finish(new Error('Windows 语音输入连接中断。')));
    child.once('close', () => finish());
    child.stdin.end(JSON.stringify(input));
  });
}
