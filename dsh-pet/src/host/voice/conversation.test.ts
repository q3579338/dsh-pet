import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createVoiceConversation } from './conversation.ts';
import type { StreamingDictation } from './codex/dictation-stream.ts';
import type { ConversationEvent } from '../../shared/voice-conversation.ts';
import type { AiRequest } from '../../standalone/ai-transport.ts';
import { WorkBuddyFailure } from '../../standalone/workbuddy/executable.ts';

async function fixture() {
  const asrs: Array<StreamingDictation & { finishText(text: string): void; stopped: boolean; chunks: number }> = [];
  const requests: AiRequest[] = [],
    states: boolean[] = [];
  let selected = { protocol: 'workbuddy', model: 'deepseek-v4-flash' };
  let ready = true;
  const service = createVoiceConversation({
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
    disable: () => {
      ready = false;
    },
  };
}
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
test('错误音色、非WorkBuddy、另一通占用或取消启动都不会创建伪连接', async () => {
  const f = await fixture();
  assert.equal((await f.service.start('fish', 'sugarbud')).ok, false);
  assert.equal((await f.service.start('fish', 'natural')).ok, false);
  f.service.stop(f.id);
  f.change();
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
