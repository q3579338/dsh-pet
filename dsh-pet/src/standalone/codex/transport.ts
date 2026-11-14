/**
 * 把原桌宠的纯文本请求接到本机 Codex，保留原人物提示词与对话记忆窗口。
 * 使用独立临时会话，用户现有聊天不会被续写或归档；停止请求时关闭本次连接。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { StandaloneAiSettings } from '../ai-config.ts';
import type { AiRequest, AiTransportEvent } from '../ai-transport.ts';
import { CodexClient, codexRecord } from './client.ts';
import { CodexQueue, type CodexEventSink } from './events.ts';
import type { DiscoveredModel } from '../ai-provider/types.ts';

/** 桌宠的 Codex 对话工作区独立于游戏项目，避免加载游戏的工程指令。 */
function chatWorkspace(): string {
  const home = process.env.DSH_HOME || join(homedir(), '.codex-bigfish');
  const workspace = join(home, 'codex-chat');
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

/** 只读本机 Codex 声明的模型，不硬编码账号未开放的型号。 */
export async function discoverCodexModels(): Promise<DiscoveredModel[]> {
  const client = new CodexClient(chatWorkspace());
  try {
    await client.initialize();
    const result = codexRecord(await client.request('model/list', { limit: 100 }));
    const models: DiscoveredModel[] = [{ id: 'default', name: '跟随本机 Codex 默认模型' }];
    for (const entry of Array.isArray(result.data) ? result.data : []) {
      const model = codexRecord(entry);
      const id = typeof model.model === 'string' ? model.model : model.id;
      if (typeof id === 'string' && id && !models.some((candidate) => candidate.id === id))
        models.push({ id, name: typeof model.displayName === 'string' ? model.displayName : id });
    }
    return models;
  } finally {
    client.close();
  }
}

/** 保留人物提示词，聊天只请求回复，不把陪伴消息作为仓库开发任务执行。 */
export async function* codexTextStream(
  settings: Readonly<StandaloneAiSettings>,
  request: AiRequest,
  signal: AbortSignal,
  publish?: CodexEventSink,
): AsyncGenerator<AiTransportEvent> {
  const cwd = chatWorkspace();
  const client = new CodexClient(cwd);
  const queue = new CodexQueue<AiTransportEvent>();
  let threadId = '';
  let sequence = 0;
  let receivedText = false;
  let completed = false;
  let ended = false;
  const emit = (type: string, data?: Record<string, unknown>): void => {
    if (threadId) publish?.({ sessionId: threadId, event: { type, seq: ++sequence, data } });
  };
  const closeOff = client.onClose((error) => queue.fail(error));
  const notificationOff = client.onNotification(({ method, params }) => {
    if (typeof params.threadId === 'string' && threadId && params.threadId !== threadId) return;
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      receivedText = true;
      queue.push({ text: params.delta });
    }
    if (method === 'item/completed') {
      const item = codexRecord(params.item);
      if (item.type === 'agentMessage' && !receivedText && typeof item.text === 'string') {
        receivedText = true;
        queue.push({ text: item.text });
      }
    }
    if (method === 'turn/completed') {
      const turn = codexRecord(params.turn);
      completed = turn.status === 'completed';
      ended = true;
      emit('turn/end', {
        reason: { kind: completed ? 'completed' : turn.status === 'interrupted' ? 'aborted' : 'error' },
      });
      if (completed) queue.end();
      else queue.fail(new Error('Codex 未完成本次回复，请重试。'));
    }
  });
  const abort = (): void => {
    queue.fail(new Error('Codex 回复已停止。'));
    client.close();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('Codex 回复已停止。');
    await client.initialize();
    const started = codexRecord(
      await client.request('thread/start', {
        cwd,
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'untrusted',
        ...(settings.model !== 'default' ? { model: settings.model } : {}),
        baseInstructions:
          'You are a desktop companion in a dedicated chat. Reply in Chinese. Do not use tools, inspect files, execute commands or change settings. Only converse with the user.',
        developerInstructions: request.system,
      }),
    );
    const thread = codexRecord(started.thread);
    if (typeof thread.id !== 'string') throw new Error('Codex 没有返回可用的对话。');
    threadId = thread.id;
    emit('turn/start');
    const text = request.messages
      .map((message) => `${message.role === 'assistant' ? '大肥鱼' : '用户'}：${message.content}`)
      .join('\n\n');
    await client.request('turn/start', {
      threadId,
      effort: 'low',
      input: [{ type: 'text', text }, ...(request.images ?? []).map((url) => ({ type: 'image', url }))],
    });
    for await (const event of queue.read()) yield event;
  } finally {
    if (threadId && !ended) emit('turn/end', { reason: { kind: 'aborted' } });
    signal.removeEventListener('abort', abort);
    notificationOff();
    closeOff();
    client.close();
  }
}
