/**
 * 把原桌宠的纯文本请求接到本机 Codex，保留原人物提示词与对话记忆窗口。
 * 使用独立临时会话，用户现有聊天不会被续写或归档；停止请求时关闭本次连接。
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { StandaloneAiSettings } from '../ai-config.ts';
import type { AiRequest, AiTransportEvent } from '../ai-transport.ts';
import { codexRecord } from './client.ts';
import { CodexQueue } from './events.ts';
import type { DiscoveredModel } from '../ai-provider/types.ts';
import { createCodexChatConnection, type CodexChatConnection } from './chat-connection.ts';
import { companionThreadConfig, selectChatModel } from './chat-policy.ts';
import { codexFailure, CodexFailure } from './errors.ts';

/** 桌宠的 Codex 对话工作区独立于游戏项目，避免加载游戏的工程指令。 */
export function codexChatWorkspace(home = process.env.DSH_HOME || join(homedir(), '.codex-bigfish')): string {
  const workspace = join(home, 'codex-chat');
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

/** 只读本机 Codex 声明的模型，不硬编码账号未开放的型号。 */
export async function discoverCodexModels(connection?: CodexChatConnection): Promise<DiscoveredModel[]> {
  const own = connection ?? createCodexChatConnection(codexChatWorkspace());
  try {
    return [
      { id: 'default', name: '自动：当前账号默认模型' },
      ...(await own.models()).map(({ id, name }) => ({ id, name })),
    ];
  } finally {
    if (!connection) own.dispose();
  }
}

/** 保留人物提示词，聊天只请求回复，不把陪伴消息作为仓库开发任务执行。 */
export async function* codexTextStream(
  settings: Readonly<StandaloneAiSettings>,
  request: AiRequest,
  signal: AbortSignal,
  connection?: CodexChatConnection,
): AsyncGenerator<AiTransportEvent> {
  const cwd = codexChatWorkspace();
  const own = connection ?? createCodexChatConnection(cwd);
  const client = await own.open();
  const queue = new CodexQueue<AiTransportEvent>();
  let threadId = '';
  let receivedText = false;
  let completed = false;
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
      if (completed && receivedText) queue.end();
      else
        queue.fail(
          turn.error
            ? codexFailure(turn.error)
            : new CodexFailure('Codex 没有返回回复文字，请查看额度或重新选择可用模型。'),
        );
    }
    if (method === 'error' && params.willRetry === false) queue.fail(codexFailure(params.error));
  });
  const abort = (): void => {
    queue.fail(new Error('Codex 回复已停止。'));
    own.reset();
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) throw new Error('Codex 回复已停止。');
    const [models, current] = await Promise.all([own.models(), client.request('config/read', {})]);
    const selected = selectChatModel(models, settings.model);
    if (signal.aborted) throw new CodexFailure('Codex 回复已停止。');
    const started = codexRecord(
      await client.request('thread/start', {
        cwd,
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        model: selected.id,
        config: companionThreadConfig(codexRecord(current).config),
        baseInstructions:
          'You are a desktop companion in a dedicated chat. Reply in Chinese. Do not use tools, inspect files, execute commands or change settings. Only converse with the user.',
        developerInstructions: request.system,
      }),
    );
    const thread = codexRecord(started.thread);
    if (typeof thread.id !== 'string') throw new Error('Codex 没有返回可用的对话。');
    threadId = thread.id;
    // 陪伴回复不写工程任务的完成状态，否则高优先级的完成气泡会盖住这句聊天。
    const text = request.messages
      .map((message) => `${message.role === 'assistant' ? '大肥鱼' : '用户'}：${message.content}`)
      .join('\n\n');
    await client.request('turn/start', {
      threadId,
      model: selected.id,
      effort: selected.effort,
      input: [{ type: 'text', text }, ...(request.images ?? []).map((url) => ({ type: 'image', url }))],
    });
    for await (const event of queue.read()) yield event;
  } catch (error) {
    own.reset();
    throw error;
  } finally {
    signal.removeEventListener('abort', abort);
    notificationOff();
    closeOff();
    if (!connection) own.dispose();
  }
}
