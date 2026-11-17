import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceConversation } from './conversation.ts';
import type { StreamingDictation } from './codex/dictation-stream.ts';
import type { ConversationEvent } from '../../shared/voice-conversation.ts';
import type { AiRequest } from '../../standalone/ai-transport.ts';
import { WorkBuddyFailure } from '../../standalone/workbuddy/executable.ts';
import { PollStateStore } from '../state.ts';
import { PlaybackStore } from '../playback.ts';
import { createVoicePresentation } from './presentation.ts';

async function fixture(
  memory?: Parameters<typeof createVoiceConversation>[0]['memory'],
  presentation?: Parameters<typeof createVoiceConversation>[0]['presentation'],
) {
  const asrs: Array<StreamingDictation & { finishText(text: string): void; stopped: boolean; chunks: number }> = [];
  const requests: AiRequest[] = [],
    states: boolean[] = [];
  let selected = { protocol: 'workbuddy', model: 'deepseek-v4-flash' };
  let ready = true;
  const service = createVoiceConversation({
    memory,
    presentation,
    selection: () => selected,
    ready: () => ready,
    prompt: (id) => (id === 'fish' ? '你是大肥鱼。' : undefined),
    activeChanged: (value) => states.push(value),
    dictation: async (partial, signal) => {
      let resolve!: (text: string) => void;
      const final = new Promise<string>((done) => {
        resolve = done;
      });
      const item = {
        stopped: false,
        available: () => !item.stopped,
        chunks: 0,
        append() {
          item.chunks++;
          partial('测试');
        },
        finish: () => final,
        finishText: (text: string) => resolve(text),
        dispose() {
          item.stopped = true;
          resolve('');
        },
      };
      signal.addEventListener('abort', () => item.dispose(), { once: true });
      asrs.push(item);
      return item;
    },
    async *stream(model, request, signal) {
      assert.equal(signal.aborted, false);
      assert.equal(model, 'deepseek-v4-flash');
      requests.push(request);
      yield { modelUsed: model };
      yield { text: '听到了，' };
      yield { text: '继续聊呀。' };
    },
  });
  const result = await service.start('fish', 'starbell');
  if (!result.ok) throw Error(result.message);
  const events = service.events(result.sessionId)[Symbol.asyncIterator]();
  const next = async () => {
    const row = await events.next();
    assert.equal(row.done, false);
    return JSON.parse(new TextDecoder().decode(row.value)) as ConversationEvent;
  };
  const until = async (type: ConversationEvent['type']) => {
    const rows: ConversationEvent[] = [];
    for (let i = 0; i < 20; i++) {
      const event = await next();
      rows.push(event);
      if (event.type === type) return rows;
    }
    throw Error('missing ' + type);
  };
  await until('ready');
  return {
    service,
    id: result.sessionId,
    asrs,
    requests,
    states,
    next,
    until,
    change: () => {
      selected = { protocol: 'codex', model: 'other' };
    },
    unsupported: () => {
      selected = { protocol: 'unsupported', model: 'other' };
    },
    disable: () => {
      ready = false;
    },
  };
}

test('Codex自定义语音用自己的识别和文字模型，动作标记不进入字幕与朗读', async () => {
  const state = new PollStateStore(),
    playback = new PlaybackStore();
  let finish!: (text: string) => void;
  const requests: AiRequest[] = [];
  const service = createVoiceConversation({
    selection: () => ({ protocol: 'codex', model: 'gpt-6-luna' }),
    prompt: () => '桌宠',
    activeChanged() {},
    presentation: (petId) =>
      createVoicePresentation({
        petId,
        state,
        playback,
        mode: 'model',
        settings: () => ({ available: true, actions: ['吃西瓜'] }),
      }),
    dictation: async (_partial, _signal, source) => {
      assert.equal(source, 'codex');
      const result = new Promise<string>((done) => {
        finish = done;
      });
      return { append() {}, finish: () => result, dispose() {} };
    },
    async *stream(model, request) {
      assert.equal(model, 'gpt-6-luna');
      requests.push(request);
      for (const text of ['喜欢呀，', '西瓜甜甜的～', '\n[动', '作:吃', '西瓜]']) yield { text };
    },
  });
  try {
    const call = await service.start('fish', 'starbell');
    assert.equal(call.ok, true);
    if (!call.ok) return;
    const events = service.events(call.sessionId)[Symbol.asyncIterator]();
    await events.next();
    await service.audio(call.sessionId, 1, 0, 'AAECAw==');
    const finishInput = finish;
    service.end(call.sessionId, 1);
    finishInput('你喜欢吃西瓜吗');
    const rows: ConversationEvent[] = [];
    for (let i = 0; i < 30; i++) {
      const row = await events.next();
      if (row.done) break;
      const event = JSON.parse(new TextDecoder().decode(row.value)) as ConversationEvent;
      rows.push(event);
      if (event.type === 'done') break;
    }
    assert.match(requests[0].messages[0].content, /\[动作:名称\]/u);
    const text = rows.flatMap((row) => (row.type === 'text' ? [row.text] : [])).join('');
    assert.equal(text, '喜欢呀，西瓜甜甜的～');
    assert.equal((state.read().pets.fish.anim.data as { name: string }).name, '吃西瓜');
  } finally {
    service.dispose();
    state.cancelAll();
  }
});
test('WorkBuddy 连续语音召回长期事实，只提交实际用户转写，停止后可以重连', async () => {
  const heard: string[] = [];
  const f = await fixture({
    context: () => '\n用户希望被称为「星宝」',
    remember: (_pet, text) => {
      heard.push(text);
      return 1;
    },
  });
  try {
    await f.service.audio(f.id, 1, 0, 'AAECAw==');
    f.service.end(f.id, 1);
    f.asrs[0].finishText('我喜欢咖啡');
    await f.until('done');
    assert.deepEqual(heard, ['我喜欢咖啡']);
    assert.match(f.requests[0].system, /星宝/u);
    f.service.stopAll();
    assert.equal((await f.service.start('fish', 'dango')).ok, true);
  } finally {
    f.service.dispose();
  }
});

test('WorkBuddy把完整识别、累计回复和取消交给同一桌宠画面，不额外请求模型', async () => {
  const frames: unknown[] = [];
  let disposed = 0;
  const f = await fixture(undefined, () => ({
    instructions: () => '可表演吃西瓜',
    accept: (frame: unknown) => {
      frames.push(frame);
      return true;
    },
    dispose: () => {
      disposed++;
    },
  }));
  try {
    await f.service.audio(f.id, 1, 0, 'AAECAw==');
    f.service.end(f.id, 1);
    f.asrs[0].finishText('你吃个西瓜给我看');
    await f.until('done');
    assert.match(f.requests[0].system, /吃西瓜/u);
    assert.equal(f.requests.length, 1);
    assert.ok(
      frames.some(
        (frame) =>
          (frame as { type: string; text: string }).type === 'user' &&
          (frame as { text: string }).text === '你吃个西瓜给我看',
      ),
    );
    assert.ok(
      frames.some(
        (frame) =>
          (frame as { complete?: boolean; text: string }).complete &&
          (frame as { text: string }).text === '听到了，继续聊呀。',
      ),
    );
    f.service.stopAll();
    assert.equal(disposed, 1);
  } finally {
    f.service.dispose();
  }
});

test('流式识别的角色专名纠正在字幕、模型和记忆中一致，不增加模型调用', async () => {
  const heard: string[] = [];
  const f = await fixture(
    {
      context: () => '',
      remember: (_id, text) => {
        heard.push(text);
        return heard.length;
      },
    },
    (petId) =>
      createVoicePresentation({
        petId,
        state: new PollStateStore(),
        playback: new PlaybackStore(),
        mode: 'model',
        settings: () => ({ available: true, actions: ['展示天圆地方'] }),
      }),
  );
  try {
    await f.service.audio(f.id, 1, 0, 'AAECAw==');
    f.service.end(f.id, 1);
    f.asrs[0].finishText('请展示天元地方给我看。');
    const events = await f.until('done');
    assert.ok(events.some((event) => event.type === 'user' && event.text === '请展示天圆地方给我看。'));
    assert.deepEqual(heard, ['请展示天圆地方给我看。']);
    assert.equal(f.requests.length, 1);
    const messages = f.requests[0].messages;
    assert.match(messages[messages.length - 1].content, /请展示天圆地方给我看/);
  } finally {
    f.service.dispose();
  }
});
test('WorkBuddy 识别启动失败提示自己的来源，不显示原始错误或 Codex 登录提示', async () => {
  const states: boolean[] = [];
  const service = createVoiceConversation({
    selection: () => ({ protocol: 'workbuddy', model: 'deepseek-v4-flash' }),
    ready: () => true,
    prompt: () => '大肥鱼',
    activeChanged: (active) => {
      states.push(active);
    },
    dictation: async () => {
      throw new Error('private upstream error');
    },
    async *stream() {
      yield { text: '不应调用' };
    },
  });
  try {
    const result = await service.start('fish', 'starbell');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.message, /WorkBuddy/);
      assert.doesNotMatch(result.message, /Codex|private/);
    }
    assert.deepEqual(states, [true, false]);
  } finally {
    service.dispose();
  }
});
test('连续两轮使用实际选中模型和角色，流式文字与最终听写分开，历史只驻留本通', async () => {
  const f = await fixture();
  try {
    for (let turn = 1; turn <= 2; turn++) {
      await f.service.audio(f.id, turn, 0, 'AAECAw==');
      f.service.end(f.id, turn);
      f.asrs[turn - 1].finishText('测试' + turn);
      const rows = await f.until('done');
      assert.ok(rows.some((row) => row.type === 'model' && row.model === 'deepseek-v4-flash'));
      assert.equal(rows.filter((row) => row.type === 'text').length, 2);
    }
    assert.equal(f.requests[0].messages.length, 1);
    assert.deepEqual(
      f.requests[1].messages.map((message) => message.role),
      ['user', 'assistant', 'user'],
    );
    assert.match(f.requests[1].system, /你是大肥鱼/);
  } finally {
    f.service.stop(f.id);
  }
  assert.equal(
    f.asrs.every((asr) => asr.stopped),
    true,
  );
  assert.deepEqual(f.states, [true, false]);
  assert.equal(f.service.touch(f.id), false);
});
test('新开口后旧识别结果不能触发回复，错序、重复和跨会话音频被拒绝', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.service.audio('other', 1, 0, 'AAEC'));
    await assert.rejects(f.service.audio(f.id, 1, 2, 'AAECAw=='));
    await f.service.audio(f.id, 1, 0, 'AAECAw==');
    await assert.rejects(f.service.audio(f.id, 1, 0, 'AAECAw=='));
    f.service.end(f.id, 1);
    await f.service.audio(f.id, 2, 0, 'AAECAw==');
    f.asrs[0].finishText('旧句不应该说出来');
    f.service.end(f.id, 2);
    f.asrs[1].finishText('新的问题');
    await f.until('done');
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].messages[0].content, '新的问题');
  } finally {
    f.service.dispose();
  }
});
test('设置变化不偷偷切模型，错误后仍能结束和重开', async () => {
  const f = await fixture();
  try {
    await f.service.audio(f.id, 1, 0, 'AAECAw==');
    f.service.end(f.id, 1);
    f.change();
    f.asrs[0].finishText('你好');
    const rows = await f.until('error');
    assert.equal(f.requests.length, 0);
    assert.ok(rows.some((row) => row.type === 'error' && row.fatal === false));
    assert.equal(f.service.touch(f.id), false);
  } finally {
    f.service.dispose();
  }
});

test('闲置识别连接断开后第一句话会重连，保留这一句已采集的音频', async () => {
  const f = await fixture();
  try {
    f.asrs[0].dispose();
    await f.service.audio(f.id, 1, 0, 'AAECAw==');
    assert.equal(f.asrs[0].chunks, 0);
    assert.equal(f.asrs[1].chunks, 1);
    f.service.end(f.id, 1);
    f.asrs[1].finishText('重连后的问题');
    await f.until('done');
    assert.equal(f.requests[0].messages[0].content, '重连后的问题');
  } finally {
    f.service.dispose();
  }
});
test('错误音色、不支持来源、另一通占用或取消启动都不会创建伪连接', async () => {
  const f = await fixture();
  assert.equal((await f.service.start('fish', 'sugarbud')).ok, false);
  assert.equal((await f.service.start('fish', 'natural')).ok, false);
  f.service.stop(f.id);
  f.unsupported();
  assert.equal((await f.service.start('fish', 'dango')).ok, false);
  f.service.dispose();
});

test('WorkBuddy暂未就绪时仍声明该来源，启动明确失败，不回退Codex回答', async () => {
  const f = await fixture();
  f.service.stop(f.id);
  f.disable();
  assert.equal(f.service.options().workbuddy, true);
  const result = await f.service.start('fish', 'starbell');
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.message, /启用并保存 WorkBuddy/u);
  f.service.dispose();
});

test('WorkBuddy登录失败准确提示来源，失败启动释放已经准备的识别连接', async () => {
  let stopped = false;
  const service = createVoiceConversation({
    selection: () => ({ protocol: 'workbuddy', model: 'deepseek-v4-flash' }),
    prompt: () => '大肥鱼',
    activeChanged() {},
    async prepare(active) {
      if (active) throw new WorkBuddyFailure('请先登录国内版 WorkBuddy。');
    },
    dictation: async () => ({
      append() {},
      finish: async () => '',
      dispose() {
        stopped = true;
      },
    }),
    stream: () => ({
      async *[Symbol.asyncIterator]() {
        yield { text: '不应调用' };
      },
    }),
  });
  assert.deepEqual(await service.start('fish', 'starbell'), { ok: false, message: '请先登录国内版 WorkBuddy。' });
  assert.equal(stopped, true);
  service.dispose();
});
