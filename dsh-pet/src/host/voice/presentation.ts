/** 将两家的即时语音送回已有桌宠气泡与播放回执链路；不合成第二份声音。 */
import { readVoicePresentationFrame } from '../../shared/voice-presentation.ts';
import { actionInstruction, extractChatAction, visibleChatText } from '../chat-action.ts';
import { playChatAction } from '../chat-presentation.ts';
import type { PollStateStore } from '../state.ts';
import type { PlaybackStore } from '../playback.ts';

export interface VoicePresentation {
  instructions(): string;
  modelInstruction?(): string;
  accept(frame: unknown): boolean;
  dispose(): void;
}

/** 从角色已有动作匹配请求和面向桌宠的喜好互动，保留否定与用户自述。 */
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
      // 文件宠物可新增展示动作；原声允许自然说“拿出一个…给我看”，仍只匹配当前角色白名单。
      const object = /^(?:展示|拿出|放出)(.+)$/u.exec(name)?.[1];
      const showObject = Boolean(
        object && /(?:展示|拿出|掏出|拿出来|亮出|秀|给我看|看看|看一下|放出)/u.test(normalized),
      );
      for (const phrase of [name, ...(aliases[name] ?? []), ...(showObject && object ? [object] : [])]) {
        const at = normalized.indexOf(phrase);
        if (at < 0) continue;
        const before = normalized.slice(0, at),
          after = normalized.slice(at + phrase.length);
        if (
          /(?:别|不要|不能|不许|不想|不喜欢|不爱|停止|取消).{0,8}$/u.test(before.replace(/能不能/gu, '')) ||
          /(?:刚|刚刚|已经|正在|昨天|以前|曾经).{0,4}$/u.test(before) ||
          /(?:我|他|她|它|我们)[^你请]{0,8}$/u.test(before.replace(/(?:给|帮)我/gu, '')) ||
          /(?:什么意思|是什么|这个词|这句话)/u.test(after)
        )
          continue;
        if (
          normalized.split(phrase).join('') === '' ||
          (showObject && phrase === object) ||
          /(?:你|请|表演|给我|帮我|给.{0,4}看|来|能不能|可以)/u.test(before + after) ||
          (/(?:喜欢|爱)$/u.test(before) && /[吗么嘛呢]/u.test(after))
        )
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
  mode?: 'native' | 'model';
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
    modelInstruction() {
      const names = settings().actions;
      return names.length ? actionInstruction(names) : '';
    },
    instructions() {
      const names = settings().actions;
      if (deps.mode === 'model')
        return '\n你是桌面角色，能通过清单中的现有动画配合对话。动作由模型按语境挑选，与文字对话相同；标记交给程序处理，不属于朗读正文。';
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
        const action = deps.mode === 'model' ? undefined : requestedVoiceAction(frame.text, selected.actions);
        if (action) {
          playChatAction(deps.state, deps.playback, deps.petId, action);
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
      const parsed = extractChatAction(frame.text, selected.actions);
      if (deps.mode === 'model' && frame.complete && parsed.action)
        playChatAction(deps.state, deps.playback, deps.petId, parsed.action);
      pending = visibleChatText(frame.text, frame.complete);
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
