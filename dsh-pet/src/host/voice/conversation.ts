/** 连续语音：WorkBuddy 自己流式识别 → 当前内置模型 → 浏览器所选真实音色。 */
import { randomUUID } from 'node:crypto';
import { createStreamingDictation, DictationStreamError, type StreamingDictation } from './codex/dictation-stream.ts';
import { liveVoiceStyle } from '../../shared/live-voice-style.ts';
import type { ConversationEvent } from '../../shared/voice-conversation.ts';
import type { AiRequest } from '../../standalone/ai-transport.ts';
import type { WorkBuddyEvent } from '../../standalone/workbuddy/connection.ts';
import { WorkBuddyFailure } from '../../standalone/workbuddy/executable.ts';

/** 宿主仅提供当前模型、角色与实际调用，测试不访问真实账号。 */
export interface ConversationDependencies {
  selection(): { protocol: string; model: string } | undefined;
  prompt(petId: string): string | undefined;
  stream(model: string, request: AiRequest, signal: AbortSignal): AsyncIterable<WorkBuddyEvent>;
  activeChanged(active: boolean): void;
  busy?(): boolean;
  ready?(): boolean;
  prepare?(active: boolean): Promise<void>;
  dictation?: typeof createStreamingDictation;
}
/** 本地会话编号只用于当前进程，关闭后不保留音频与聊天记录。 */
export interface VoiceConversationService {
  options(): { workbuddy: boolean; model: string; source: string };
  start(
    petId: string,
    styleId: string,
    signal?: AbortSignal,
  ): Promise<{ ok: true; sessionId: string; model: string } | { ok: false; message: string }>;
  events(id: string, signal?: AbortSignal): AsyncIterable<Uint8Array>;
  audio(id: string, utterance: number, sequence: number, audio: string): Promise<void>;
  end(id: string, utterance: number): void;
  interrupt(id: string): void;
  touch(id: string): boolean;
  stop(id: string): void;
  dispose(): void;
}

/** 一个监听者、一个输入和一个回复；新开口取消旧回复，过期或断开释放所有本通连接。 */
export function createVoiceConversation(deps: ConversationDependencies): VoiceConversationService {
  type Input = { id: number; sequence: number; epoch: number; asr: StreamingDictation; bytes: number };
  type Room = {
    id: string;
    model: string;
    prompt: string;
    abort: AbortController;
    epoch: number;
    lastUtterance: number;
    history: AiRequest['messages'];
    input?: Input;
    warm?: Promise<StreamingDictation>;
    asrs: Set<StreamingDictation>;
    reply?: AbortController;
    queue: ConversationEvent[];
    warmAt?: number;
    opening?: boolean;
    wake?: () => void;
    listening: boolean;
    touch: number;
    timer?: ReturnType<typeof setInterval>;
  };
  let active: Room | undefined;
  let disposed = false;
  const options = () => {
    const selection = deps.selection();
    return {
      workbuddy: selection?.protocol === 'workbuddy',
      model: selection?.model ?? '',
      source: selection?.protocol ?? '',
    };
  };
  const release = (room: Room): void => {
    if (room.abort.signal.aborted) return;
    room.abort.abort();
    room.reply?.abort();
    clearInterval(room.timer);
    for (const asr of room.asrs) asr.dispose();
    room.asrs.clear();
    room.queue = [];
    room.wake?.();
    void deps.prepare?.(false).catch(() => {});
    if (active === room) {
      active = undefined;
      deps.activeChanged(false);
    }
  };
  const emit = (room: Room, event: ConversationEvent): void => {
    if (room.abort.signal.aborted) return;
    if (room.queue.length >= 128) {
      release(room);
      return;
    }
    room.queue.push(event);
    room.wake?.();
  };
  const requireRoom = (id: string): Room => {
    if (!active || active.id !== id || active.abort.signal.aborted) throw new Error('语音会话已结束，请重新开始。');
    const selection = deps.selection();
    if (selection?.protocol !== 'workbuddy' || selection.model !== active.model) {
      release(active);
      throw new Error('连接来源已切换，请重新开始语音。');
    }
    active.touch = Date.now();
    return active;
  };
  const warm = (room: Room): Promise<StreamingDictation> => {
    if (room.warm) return room.warm;
    let prepared: StreamingDictation | undefined;
    if (!deps.dictation) throw new WorkBuddyFailure('WorkBuddy 流式识别组件暂不可用。');
    const promise = deps
      .dictation((text) => {
        if (room.input?.asr === prepared) emit(room, { type: 'partial', text });
      }, room.abort.signal)
      .then((asr) => {
        if (room.abort.signal.aborted) {
          asr.dispose();
          throw new Error('stopped');
        }
        prepared = asr;
        room.warmAt = Date.now();
        room.asrs.add(asr);
        return asr;
      });
    room.warm = promise;
    void promise.catch(() => {
      if (room.warm === promise) room.warm = undefined;
    });
    return promise;
  };
  const interrupt = (room: Room): void => {
    room.epoch++;
    room.reply?.abort();
    room.reply = undefined;
    emit(room, { type: 'interrupted' });
  };
  const complete = async (room: Room, input: Input): Promise<void> => {
    try {
      const user = await input.asr.finish();
      if (room.abort.signal.aborted || input.epoch !== room.epoch) return;
      if (!user || !/[\p{L}\p{N}]/u.test(user)) return;
      emit(room, { type: 'user', text: user });
      const selection = deps.selection();
      if (selection?.protocol !== 'workbuddy' || selection.model !== room.model)
        throw new WorkBuddyFailure('模型设置已变化，请结束语音后重新开始。');
      const abort = new AbortController();
      room.reply = abort;
      emit(room, { type: 'reply' });
      let answer = '';
      for await (const event of deps.stream(
        room.model,
        {
          system: room.prompt,
          messages: [...room.history, { role: 'user', content: user }],
        },
        AbortSignal.any([room.abort.signal, abort.signal]),
      )) {
        if (room.abort.signal.aborted || input.epoch !== room.epoch || abort.signal.aborted) return;
        if (event.modelUsed) emit(room, { type: 'model', model: event.modelUsed });
        if (event.text) {
          answer += event.text;
          if (answer.length > 4000) throw new WorkBuddyFailure('回复太长，请换个简短问题。');
          emit(room, { type: 'text', text: event.text });
        }
      }
      if (!answer.trim()) throw new WorkBuddyFailure('DeepSeek 暂时没有回复，请继续说话重试。');
      if (room.abort.signal.aborted || input.epoch !== room.epoch) return;
      room.history.push({ role: 'user', content: user }, { role: 'assistant', content: answer });
      while (room.history.length > 12 || room.history.reduce((n, message) => n + message.content.length, 0) > 8000)
        room.history.splice(0, 2);
      room.reply = undefined;
      emit(room, { type: 'done' });
    } catch (error) {
      if (room.abort.signal.aborted || input.epoch !== room.epoch) return;
      room.reply = undefined;
      emit(room, {
        type: 'error',
        fatal: false,
        message:
          error instanceof WorkBuddyFailure || error instanceof DictationStreamError
            ? error.message
            : '这一句暂时没有成功，请继续说话重试。',
      });
    } finally {
      room.asrs.delete(input.asr);
      input.asr.dispose();
    }
  };
  return {
    options,
    async start(petId, styleId, signal) {
      const selected = options(),
        prompt = deps.prompt(petId),
        style = liveVoiceStyle(styleId);
      if (disposed || !selected.workbuddy || !selected.model)
        return { ok: false, message: '请先在模型连接中选择国内版 WorkBuddy。' };
      if (deps.ready?.() === false) return { ok: false, message: '请先启用并保存 WorkBuddy 模型连接，再开始语音。' };
      if (!prompt || !style?.synthesisVoice) return { ok: false, message: '请选择桌宠和自定义音色。' };
      if (active || deps.busy?.()) return { ok: false, message: '已有即时语音正在连接或聊天，请先结束。' };
      const room: Room = {
        id: randomUUID(),
        model: selected.model,
        prompt:
          prompt +
          '\n你正在进行实时中文语音闲聊。直接回答刚听到的话，通常一两句、60字以内；第一小句先回答重点。不要输出JSON、Markdown、思考过程、工具调用或舞台动作。不要固定开场白或先说“让我想想”。\n' +
          style.instructions,
        abort: new AbortController(),
        epoch: 0,
        lastUtterance: 0,
        history: [],
        asrs: new Set(),
        queue: [],
        listening: false,
        touch: Date.now(),
      };
      active = room;
      deps.activeChanged(true);
      const cancel = () => release(room);
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        if (signal?.aborted) throw new Error('stopped');
        await Promise.all([warm(room), deps.prepare?.(true)]);
        if (room.abort.signal.aborted) throw new Error('stopped');
        room.timer = setInterval(() => {
          if (Date.now() - room.touch > 40000) release(room);
          else {
            if (room.warm && room.warmAt && Date.now() - room.warmAt > 240000) {
              const old = room.warm;
              room.warm = undefined;
              room.warmAt = undefined;
              void old
                .then((asr) => {
                  room.asrs.delete(asr);
                  asr.dispose();
                })
                .catch(() => {});
              void warm(room).catch(() => {});
            }
            emit(room, { type: 'ping' });
          }
        }, 5000);
        room.timer.unref?.();
        emit(room, { type: 'ready', model: room.model });
        return { ok: true, sessionId: room.id, model: room.model };
      } catch (error) {
        release(room);
        return {
          ok: false,
          message:
            error instanceof WorkBuddyFailure ? error.message : '流式语音识别未能连接，请检查 Codex 登录和网络后重试。',
        };
      } finally {
        signal?.removeEventListener('abort', cancel);
      }
    },
    async *events(id, signal) {
      const room = requireRoom(id);
      if (room.listening) throw new Error('此语音会话已有监听窗口。');
      room.listening = true;
      const abort = () => release(room);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        while (!room.abort.signal.aborted && !signal?.aborted) {
          const event = room.queue.shift();
          if (event) yield new TextEncoder().encode(JSON.stringify(event) + '\n');
          else
            await new Promise<void>((resolve) => {
              room.wake = resolve;
            });
        }
      } finally {
        signal?.removeEventListener('abort', abort);
        release(room);
      }
    },
    async audio(id, utterance, sequence, audio) {
      const room = requireRoom(id);
      if (
        !Number.isSafeInteger(utterance) ||
        utterance < 1 ||
        !Number.isSafeInteger(sequence) ||
        sequence < 0 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(audio) ||
        audio.length > 22000 ||
        audio.length % 4
      )
        throw new Error('语音片段无效。');
      const pcm = Buffer.from(audio, 'base64');
      if (pcm.length % 2 || pcm.length < 2 || pcm.length > 16384) throw new Error('语音片段无效。');
      if (!room.input) {
        if (sequence !== 0 || utterance <= room.lastUtterance || room.asrs.size > 2 || room.opening)
          throw new Error('语音片段顺序无效。');
        interrupt(room);
        const epoch = room.epoch;
        room.opening = true;
        let asr: StreamingDictation;
        try {
          asr = await warm(room);
          if (asr.available?.() === false) {
            room.asrs.delete(asr);
            asr.dispose();
            room.warm = undefined;
            room.warmAt = undefined;
            asr = await warm(room);
          }
        } finally {
          room.opening = false;
        }
        if (room.abort.signal.aborted || epoch !== room.epoch) throw new Error('语音片段已停止。');
        room.warm = undefined;
        room.warmAt = undefined;
        room.input = { id: utterance, sequence: 0, epoch, asr, bytes: 0 };
        room.lastUtterance = utterance;
      }
      const input = room.input;
      if (input.id !== utterance || input.sequence !== sequence) throw new Error('语音片段顺序无效。');
      input.bytes += pcm.length;
      if (input.bytes > 960000) throw new Error('一句话最多30秒，请分句说话。');
      input.asr.append(pcm);
      input.sequence++;
    },
    end(id, utterance) {
      const room = requireRoom(id),
        input = room.input;
      if (!input || input.id !== utterance) throw new Error('语音片段已结束。');
      room.input = undefined;
      void complete(room, input);
      void warm(room).catch(() => {});
    },
    interrupt(id) {
      interrupt(requireRoom(id));
    },
    touch(id) {
      try {
        requireRoom(id);
        return true;
      } catch {
        return false;
      }
    },
    stop(id) {
      if (active?.id === id) release(active);
    },
    dispose() {
      disposed = true;
      if (active) release(active);
    },
  };
}
