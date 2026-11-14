/**
 * 只读最近 Codex rollout 的状态事件，为桌面端现有聊天提供动画联动。
 * 只投影开始、工具、等待与结束；聊天正文、工具参数和输出不会交给桌宠模型。
 * 日志格式不认识时不猜测成功，所有计时器与文件句柄由本实例释放。
 */
import { open, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { CodexEventSink, CodexSessionEvent } from './events.ts';
import { codexRecord } from './client.ts';

/** 不保存原始载荷，只转换能明确识别的状态事件。 */
export function rolloutEvent(record: unknown): CodexSessionEvent['event'] | undefined {
  const entry = codexRecord(record);
  const payload = codexRecord(entry.payload);
  if (entry.type === 'event_msg') {
    if (payload.type === 'task_started') return { type: 'turn/start' };
    if (payload.type === 'task_complete') return { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    if (payload.type === 'turn_aborted') return { type: 'turn/end', data: { reason: { kind: 'aborted' } } };
    if (payload.type === 'task_failed') return { type: 'turn/end', data: { reason: { kind: 'error' } } };
    if (payload.type === 'approval_requested' || payload.type === 'request_user_input')
      return { type: 'approval/asked' };
  }
  if (entry.type !== 'response_item') return undefined;
  if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
    const waiting = typeof payload.name === 'string' && /request_user_input|ask_user_question/.test(payload.name);
    return waiting
      ? { type: 'approval/asked' }
      : {
          type: 'tool/call',
          data: { name: 'Codex 操作', callId: typeof payload.call_id === 'string' ? payload.call_id : undefined },
        };
  }
  if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output')
    return {
      type: 'tool/result',
      data: { message: { source: { callId: typeof payload.call_id === 'string' ? payload.call_id : undefined } } },
    };
  return undefined;
}

/** 一个文件的增量游标；记录被截断或替换时重新建立游标。 */
interface Cursor {
  offset: number;
  carry: string;
  sequence: number;
  discardingLine: boolean;
}

/** 最近七天、最多 64 个文件；新启动时不重放旧的完成/通知事件。 */
export function startCodexMonitor(
  publish: CodexEventSink,
  home = process.env.CODEX_HOME || join(homedir(), '.codex'),
): () => void {
  const cursors = new Map<string, Cursor>();
  let disposed = false;
  let scanning = false;
  let initialScan = true;
  const scan = async (): Promise<void> => {
    if (disposed || scanning) return;
    scanning = true;
    try {
      const files: Array<{ path: string; mtime: number }> = [];
      for (let day = 0; day < 7; day++) {
        const date = new Date(Date.now() - day * 86_400_000);
        const directory = join(
          home,
          'sessions',
          String(date.getUTCFullYear()),
          String(date.getUTCMonth() + 1).padStart(2, '0'),
          String(date.getUTCDate()).padStart(2, '0'),
        );
        const names = await readdir(directory).catch(() => [] as string[]);
        for (const name of names.filter((candidate) => candidate.endsWith('.jsonl'))) {
          const path = join(directory, name);
          const attributes = await stat(path).catch(() => undefined);
          if (attributes?.isFile()) files.push({ path, mtime: attributes.mtimeMs });
        }
      }
      files.sort((left, right) => right.mtime - left.mtime);
      const selected = files.slice(0, 64);
      const selectedPaths = new Set(selected.map((file) => file.path));
      for (const path of cursors.keys()) if (!selectedPaths.has(path)) cursors.delete(path);
      for (const file of selected) {
        if (disposed) break;
        await readEvents(file.path, file.mtime);
      }
    } finally {
      initialScan = false;
      scanning = false;
    }
  };
  const readEvents = async (path: string, mtime: number): Promise<void> => {
    const sessionId = path.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/i)?.[1];
    if (!sessionId) return;
    const handle = await open(path, 'r').catch(() => undefined);
    if (!handle) return;
    try {
      const attributes = await handle.stat();
      const previous = cursors.get(path);
      const initial = !previous || attributes.size < previous.offset;
      const offset = Math.max(0, attributes.size - 262_144);
      const cursor = initial ? { offset, carry: '', sequence: 0, discardingLine: offset > 0 } : previous;
      const length = Math.min(attributes.size - cursor.offset, 262_144);
      if (length <= 0) return;
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, cursor.offset);
      cursor.offset += bytesRead;
      const lines = (cursor.carry + buffer.subarray(0, bytesRead).toString('utf8')).split('\n');
      cursor.carry = lines.pop() ?? '';
      if (cursor.discardingLine && lines.length) {
        lines.shift();
        cursor.discardingLine = false;
      }
      // 工具的大体积单行不需要存进桌宠内存；等下一行再识别状态。
      if (cursor.carry.length > 262_144) {
        cursor.carry = '';
        cursor.discardingLine = true;
      }
      const events: CodexSessionEvent['event'][] = [];
      for (const line of lines) {
        try {
          const event = rolloutEvent(JSON.parse(line));
          if (event) events.push(event);
        } catch {
          /* 部分写入与未知记录不会转换成完成。 */
        }
      }
      cursors.set(path, cursor);
      const latest = events[events.length - 1];
      const replay =
        initial && initialScan
          ? latest && latest.type !== 'turn/end' && mtime >= Date.now() - 300_000
            ? [latest]
            : []
          : events;
      for (const event of replay) if (!disposed) publish({ sessionId, event: { ...event, seq: ++cursor.sequence } });
    } finally {
      await handle.close();
    }
  };
  const poll = (): void => {
    void scan().catch(() => undefined);
  };
  const timer = setInterval(poll, 2000);
  timer.unref();
  poll();
  return () => {
    disposed = true;
    clearInterval(timer);
    cursors.clear();
  };
}
