/** 国内版 WorkBuddy 内置模型；加密登录及实际请求只在其本机运行组件内处理。 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AiRequest, AiTransportEvent } from '../ai-transport.ts';
import type { DiscoveredModel } from '../ai-provider/types.ts';
import { resolveWorkBuddyCommand, WorkBuddyFailure, type WorkBuddyCommand } from './executable.ts';
import { runWorkBuddy } from './process.ts';
import { validWorkBuddyModel, workBuddyEvents } from './events.ts';
import { createWorkBuddySession } from './session.ts';
/** 模型标识由服务端返回，测试连接可核对实际返回的型号。 */
export type WorkBuddyEvent = AiTransportEvent & { modelUsed?: string };
/** 只在明确选择 WorkBuddy 时创建进程，退出时释放自己创建的全部请求。 */
export interface WorkBuddyConnection {
  models(): Promise<DiscoveredModel[]>;
  stream(model: string, request: AiRequest, signal: AbortSignal, maxTokens?: number): AsyncIterable<WorkBuddyEvent>;
  test(model: string): Promise<{ reply: string; modelUsed?: string }>;
  prepareVoice?(active: boolean): Promise<void>;
  dispose(): void;
}
/** 源码和已打包入口各保留一个固定候选，不接受网页传入脚本路径。 */
function nativeWorker(): string {
  const folder = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(folder, '../runtime/workbuddy-native.cjs'),
    resolve(folder, '../../../runtime/workbuddy-native.cjs'),
  ];
  const worker = candidates.find((file) => existsSync(file));
  if (!worker) throw new WorkBuddyFailure('WorkBuddy 接入组件缺失，请重新解压完整程序。');
  return worker;
}
/** 测试可替换执行器，生产只运行本机国内版。 */
export function createWorkBuddyConnection(
  home: string,
  command: () => WorkBuddyCommand = resolveWorkBuddyCommand,
): WorkBuddyConnection {
  const cwd = join(home, 'workbuddy-chat'),
    active = new Set<AbortController>();
  let disposed = false;
  let session: ReturnType<typeof createWorkBuddySession> | undefined;
  const run = async function* (input: unknown, signal?: AbortSignal) {
    if (disposed) throw new WorkBuddyFailure('WorkBuddy 连接已关闭。');
    mkdirSync(cwd, { recursive: true });
    const abort = new AbortController();
    active.add(abort);
    const events = workBuddyEvents();
    let pending = '';
    try {
      const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
      if (session) {
        for await (const line of session.run(input, combined)) yield events.accept(line);
        events.finish();
        return;
      }
      for await (const part of runWorkBuddy(command(), [nativeWorker()], cwd, JSON.stringify(input), combined, 60000)) {
        pending += part;
        if (pending.length > 1024 * 1024) throw new WorkBuddyFailure('WorkBuddy 返回内容过大，已停止。');
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const event = events.accept(pending.slice(0, end));
          pending = pending.slice(end + 1);
          yield event;
        }
      }
      if (pending.trim()) yield events.accept(pending);
      events.finish();
    } finally {
      active.delete(abort);
      abort.abort();
    }
  };
  const connection: WorkBuddyConnection = {
    async prepareVoice(active) {
      if (!active) {
        session?.dispose();
        session = undefined;
        return;
      }
      if (session || disposed) return;
      mkdirSync(cwd, { recursive: true });
      const prepared = createWorkBuddySession(command, nativeWorker(), cwd);
      session = prepared;
      try {
        await connection.models();
      } catch (error) {
        prepared.dispose();
        if (session === prepared) session = undefined;
        throw error;
      }
    },
    async models() {
      let models: DiscoveredModel[] = [];
      for await (const event of run({ action: 'models' }, AbortSignal.timeout(20000)))
        if (event.models) models = event.models;
      if (!models.length) throw new WorkBuddyFailure('WorkBuddy 没有返回内置模型目录。');
      return models;
    },
    async *stream(model, request, signal, maxTokens = 1024) {
      if (!validWorkBuddyModel(model)) throw new WorkBuddyFailure('WorkBuddy 内置模型 ID 无效，请从在线目录重新选择。');
      if (request.images?.length) throw new WorkBuddyFailure('当前 WorkBuddy 接入只支持文字，请切回 Codex 发送附图。');
      for await (const event of run({ action: 'chat', model, request, maxTokens }, signal))
        if (event.text || event.modelUsed) yield event;
    },
    async test(model) {
      let reply = '',
        modelUsed: string | undefined;
      for await (const event of connection.stream(
        model || 'deepseek-v4-flash',
        { system: '只回复“连接成功”。', messages: [{ role: 'user', content: '请确认连接。' }] },
        AbortSignal.timeout(30000),
        128,
      )) {
        reply += event.text ?? '';
        if (event.modelUsed) modelUsed = event.modelUsed;
      }
      if (!reply) throw new WorkBuddyFailure('WorkBuddy 没有返回文字，请重试。');
      return { reply, modelUsed };
    },
    dispose() {
      disposed = true;
      session?.dispose();
      session = undefined;
      for (const abort of active) abort.abort();
      active.clear();
    },
  };
  return connection;
}
