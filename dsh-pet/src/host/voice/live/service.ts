/** 原生即时语音的连接所有者：结束、断开或页面租约过期时，只释放自己创建的 Codex。 */
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CodexClient, codexRecord } from '../../../standalone/codex/client.ts';
import { companionThreadConfig, parseChatModels, selectChatModel } from '../../../standalone/codex/chat-policy.ts';
import { readCodexSpeechIdentity } from '../codex/auth.ts';
import { createCodexLiveCall, LiveVoiceError } from './http.ts';
import { DEFAULT_LIVE_VOICE_STYLE, liveVoiceStyle } from '../../../shared/live-voice-style.ts';
import type { LongTermMemory } from '../../long-term-memory/service.ts';

/** 页面拿不到账号令牌，只拿到这次协商必需的 SDP 和本地会话编号。 */
export type LiveStartResult = { ok: true; sessionId: string; answerSdp: string } | { ok: false; message: string };
/** 结束操作幂等；编号不匹配时不会影响其他通话。 */
export interface LiveVoiceService {
  stopAll(): void;
  start(petId: string, sdp: string, signal?: AbortSignal, styleId?: string): Promise<LiveStartResult>;
  touch(sessionId: string): boolean;
  stop(sessionId: string): Promise<void>;
  dispose(): void;
}

/** 连接使用的最小接口；隔离验证不启动真实录音或子进程。 */
type LiveClient = Pick<CodexClient, 'initialize' | 'request' | 'onNotification' | 'onClose' | 'close'>;
/** 提示词与普通对话模型按当前宠物读取，网络能力可由隔离测试替换。 */
interface LiveDependencies {
  memory?: Pick<LongTermMemory, 'context' | 'remember'>;
  home: string;
  settings(petId: string): { prompt: string; model: string } | undefined;
  activeChanged(active: boolean): void;
  busy?(): boolean;
  source?(): string | undefined;
  createClient?(cwd: string): LiveClient;
  identity?: typeof readCodexSpeechIdentity;
  createCall?: typeof createCodexLiveCall;
}

/** 每次只建一通独立、只读、临时的 Codex 会话，普通聊天记忆不被修改。 */
export function createLiveVoiceService(deps: LiveDependencies): LiveVoiceService {
  type Room = {
    id: string;
    client: LiveClient;
    abort: AbortController;
    threadId?: string;
    started: boolean;
    released: boolean;
    touch: number;
    activity: number;
    timer?: ReturnType<typeof setInterval>;
    off?: () => void;
    offClose?: () => void;
  };
  let active: Room | undefined;
  const release = (room: Room): void => {
    if (room.released) return;
    room.released = true;
    clearInterval(room.timer);
    room.abort.abort();
    room.off?.();
    room.offClose?.();
    if (active === room) {
      active = undefined;
      deps.activeChanged(false);
    }
    room.client.close();
  };
  const stop = async (id: string): Promise<void> => {
    const room = active;
    if (!room || room.id !== id) return;
    active = undefined;
    deps.activeChanged(false);
    clearInterval(room.timer);
    room.abort.abort();
    room.off?.();
    room.offClose?.();
    try {
      if (room.started && room.threadId)
        await room.client.request('thread/realtime/stop', { threadId: room.threadId }, 1500);
    } catch {
      /* 已断开的通话仍视为停止；不把底层错误或凭据传给页面。 */
    } finally {
      release(room);
    }
  };
  return {
    stopAll() {
      if (active) release(active);
    },
    async start(petId, sdp, signal, styleId = DEFAULT_LIVE_VOICE_STYLE) {
      if (deps.source && deps.source() !== 'codex')
        return { ok: false, message: 'Codex 原声仅用于 Codex 连接。当前选择 WorkBuddy 时请使用自定义音色。' };
      if (deps.busy?.()) return { ok: false, message: '请先结束当前的 WorkBuddy 连续语音。' };
      if (signal?.aborted) return { ok: false, message: '即时语音已停止。' };
      const selected = deps.settings(petId);
      const settings = selected
        ? { ...selected, prompt: selected.prompt + (deps.memory?.context(petId) ?? '') }
        : undefined;
      const style = liveVoiceStyle(styleId);
      if (!style) return { ok: false, message: '没有找到所选的即时语音风格，请重新选择。' };
      if (!settings || !sdp.startsWith('v=0') || sdp.length > 65536)
        return { ok: false, message: '即时语音连接参数无效。' };
      if (active) return { ok: false, message: '已有即时语音正在连接或通话，请先结束。' };
      const cwd = join(deps.home, 'codex-voice');
      mkdirSync(cwd, { recursive: true });
      const room: Room = {
        id: randomUUID(),
        client: deps.createClient?.(cwd) ?? new CodexClient(cwd),
        abort: new AbortController(),
        started: false,
        released: false,
        touch: Date.now(),
        activity: Date.now(),
      };
      active = room;
      deps.activeChanged(true);
      const abandon = (): void => release(room);
      signal?.addEventListener('abort', abandon, { once: true });
      room.offClose = room.client.onClose(abandon);
      const deadline = setTimeout(abandon, 30000);
      try {
        if (signal?.aborted) throw new LiveVoiceError('即时语音已停止。');
        await room.client.initialize();
        const [auth, rawConfig, rawModels] = await Promise.all([
          (deps.identity ?? readCodexSpeechIdentity)(room.abort.signal),
          room.client.request('config/read', {}),
          room.client.request('model/list', { limit: 100, includeHidden: false }),
        ]);
        const catalog = codexRecord(rawModels).data;
        const model = selectChatModel(parseChatModels(Array.isArray(catalog) ? catalog : []), settings.model);
        const started = codexRecord(
          await room.client.request('thread/start', {
            cwd,
            ephemeral: true,
            sandbox: 'read-only',
            approvalPolicy: 'never',
            model: model.id,
            config: { ...companionThreadConfig(codexRecord(rawConfig).config), model_reasoning_effort: model.effort },
            baseInstructions:
              'Only converse briefly in Chinese. Do not use tools, inspect files, execute commands, or change settings.',
          }),
        );
        const threadId = codexRecord(started.thread).id;
        if (typeof threadId !== 'string') throw new LiveVoiceError('Codex 未能创建语音会话。');
        room.threadId = threadId;
        const call = await (deps.createCall ?? createCodexLiveCall)({
          sdp,
          threadId,
          sessionId: room.id,
          prompt:
            settings.prompt +
            '\n【声音与节奏】' +
            style.instructions +
            '\n只进行简短自然的中文语音闲聊，不操作文件，不使用工具，不发起任务委托。不解释声音设定，直接用所选声音说话。',
          model: model.id,
          effort: model.effort,
          identity: auth,
          signal: room.abort.signal,
        });
        room.off = room.client.onNotification(({ method, params }) => {
          if (params.threadId !== threadId || room.released) return;
          if (method === 'thread/realtime/transcript/done') {
            room.activity = Date.now();
            if (params.role === 'user' && typeof params.text === 'string' && params.text.length <= 5000)
              deps.memory?.remember(petId, params.text, 'codex-voice');
          }
          if (method === 'thread/realtime/error' || method === 'thread/realtime/closed') release(room);
        });
        await room.client.request(
          'thread/realtime/start',
          {
            threadId,
            outputModality: 'audio',
            version: 'v3',
            transport: { type: 'existingCall', callId: call.callId },
            includeStartupContext: false,
            realtimeSessionId: room.id,
          },
          10000,
        );
        if (active !== room || room.abort.signal.aborted) throw new LiveVoiceError('即时语音已停止。');
        room.started = true;
        room.timer = setInterval(() => {
          const now = Date.now();
          if (now - room.touch > 45000 || now - room.activity > 120000) void stop(room.id);
        }, 5000);
        room.timer.unref();
        return { ok: true, sessionId: room.id, answerSdp: call.answerSdp };
      } catch (error) {
        release(room);
        return {
          ok: false,
          message:
            error instanceof LiveVoiceError ? error.message : '即时语音连接失败，请检查 Codex 登录和网络后重试。',
        };
      } finally {
        clearTimeout(deadline);
        signal?.removeEventListener('abort', abandon);
      }
    },
    touch(id) {
      if (!active || active.id !== id) return false;
      active.touch = Date.now();
      return true;
    },
    stop,
    dispose() {
      if (active) release(active);
    },
  };
}
