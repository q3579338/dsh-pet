/** 将两家的即时语音送回已有桌宠气泡与播放回执链路；不合成第二份声音。 */
import { readVoicePresentationFrame } from '../../shared/voice-presentation.ts';
import { extractChatAction } from '../chat-action.ts';
import type { PollStateStore } from '../state.ts';
import type { PlaybackStore } from '../playback.ts';

export interface VoicePresentation {
  instructions(): string;
  accept(frame: unknown): boolean;
  dispose(): void;
}

/** 只从当前角色已有的动作里匹配明确请求，保留否定与用户自述。 */
export function requestedVoiceAction(text: string, names: readonly string[]): string | undefined {
  const aliases: Record<string, string[]> = {
    小幅度原地360度旋转展示: ['转圈'],
    超大伸懒腰: ['伸懒腰'],
    女仆屈膝礼仪: ['鞠躬', '行礼'],
    鲸鱼吐泡泡特效: ['吐泡泡'],
  };
  for (const clause of text.split(/[，。！？、,.!?；;\n]/u)) {
    const normalized = clause
      .replace(/[\s：:~～]/gu, '')
      .replace(/吃(?:一[个块口颗]|个|块|口|点|一下)/gu, '吃')
      .replace(/转(?:一个|个)/gu, '转')
      .replace(/伸(?:一个|个)/gu, '伸');
    for (const name of [...names].sort((a, b) => b.length - a.length)) {
      for (const phrase of [name, ...(aliases[name] ?? [])]) {
        const at = normalized.indexOf(phrase);
        if (at < 0) continue;
        const before = normalized.slice(0, at),
          after = normalized.slice(at + phrase.length);
        if (
          /(?:别|不要|不能|不许|不想|停止|取消).{0,8}$/u.test(before.replace(/能不能/gu, '')) ||
          /(?:喜欢|爱|刚|刚刚|已经|正在|昨天|以前|曾经).{0,4}$/u.test(before) ||
          /(?:我|他|她|它|我们)[^你请]{0,8}$/u.test(before) ||
          /(?:什么意思|是什么|这个词|这句话)/u.test(after)
        )
          continue;
        if (normalized === phrase || /(?:你|请|表演|给我|帮我|给.{0,4}看|来|能不能|可以)/u.test(before + after))
          return name;
      }
    }
  }
  return;
}

export function createVoicePresentation(deps: {
  petId: string;
  state: PollStateStore;
  playback: PlaybackStore;
  settings(): { available: boolean; actions: string[] };
}): VoicePresentation {
  let disposed = false,
    sequence = 0,
    owned = 0,
    previous = '',
    pending = '';
  let timer: ReturnType<typeof setTimeout> | undefined;
  const users = new Set<string>(),
    closed = new Set<string>();
  let assistantId: string | undefined;
  const close = (id: string | undefined) => {
    if (!id) return;
    closed.add(id);
    if (closed.size > 128) closed.delete(closed.values().next().value!);
  };
  const settings = () => {
    try {
      return deps.settings();
    } catch {
      return { available: false, actions: [] };
    }
  };
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
    pending = '';
    previous = '';
    if (owned && deps.state.read().pets[deps.petId]?.say.counter === owned)
      deps.state.writePet(deps.petId, 'say', { clear: true });
    owned = 0;
  };
  const flush = () => {
    timer = undefined;
    if (disposed || !pending || !settings().available || pending === previous) return;
    previous = pending;
    deps.state.writePet(deps.petId, 'say', {
      text: pending,
      anim: false,
      duration: Math.min(30000, Math.max(10000, pending.length * 240)),
    });
    owned = deps.state.read().pets[deps.petId].say.counter;
  };
  return {
    instructions() {
      const names = settings().actions;
      return (
        '\n【桌宠动画互动】你是屏幕上会动的桌宠角色，你的回答会同步显示在头顶气泡。' +
        (names.length
          ? '你可以通过桌宠现有动画表演：' +
            names.join('、') +
            '。用户让你“吃西瓜”“转个圈”等，是请求桌面角色动画，不是让AI拥有现实身体。程序会自动播放匹配的已有动画，不需要你调用工具。请直接用角色口吻配合，例如用户说“你吃个西瓜给我看”，回答“啊呜，西瓜甜甜的～”。不要回复“没法真的吃”“只能想象”“无法表演”，因为桌面已经能够播放对应动画。'
          : '当前未开启对话动作联动。') +
        '不要输出动作标记、控制代码或虚构未提供的动画。'
      );
    },
    accept(raw) {
      const frame = readVoicePresentationFrame(raw);
      if (disposed || !frame || frame.sequence <= sequence) return false;
      sequence = frame.sequence;
      const selected = settings();
      if (!selected.available) {
        clear();
        return false;
      }
      if (frame.type === 'interrupt') {
        close(assistantId);
        close(frame.turnId);
        assistantId = undefined;
        clear();
        return true;
      }
      if (frame.type === 'user') {
        if (users.has(frame.turnId)) return true;
        users.add(frame.turnId);
        if (users.size > 64) users.delete(users.values().next().value!);
        close(assistantId);
        assistantId = undefined;
        clear();
        const action = requestedVoiceAction(frame.text, selected.actions);
        if (action) {
          const record = deps.playback.create(deps.petId, action);
          deps.state.writePet(deps.petId, 'anim', { name: action, playbackId: record.playbackId });
        }
        return true;
      }
      if (closed.has(frame.turnId)) return false;
      if (assistantId !== frame.turnId) {
        close(assistantId);
        clearTimeout(timer);
        timer = undefined;
        previous = '';
        assistantId = frame.turnId;
      }
      pending = extractChatAction(frame.text, [])
        .text.replace(/\[动作[:：][^\]]*$/u, '')
        .trim();
      if (frame.complete || !previous) {
        clearTimeout(timer);
        if (frame.complete && !pending) clear();
        else flush();
      } else if (!timer) {
        timer = setTimeout(flush, 160);
        timer.unref?.();
      }
      if (frame.complete) close(frame.turnId);
      return true;
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      pending = '';
    },
  };
}
