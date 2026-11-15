import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomSpeechQueue } from './custom-speech.ts';

/** 让队列的 Promise 链完成一轮，不需要真实计时或音频设备。 */
async function tick(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('较短的完整首句立即合成，不等八个字或整轮结束', async () => {
  const requested: string[] = [];
  const queue = createCustomSpeechQueue({
    failure: () => assert.fail(),
    sink: {
      synthesize: async (text) => {
        requested.push(text);
        return new Blob([text]);
      },
      play: async () => {},
    },
  });
  queue.begin();
  queue.append('你好呀，');
  await tick();
  assert.deepEqual(requested, ['你好呀，']);
  queue.append('今天也陪着你。');
  queue.finish();
  await tick();
  assert.equal(requested.join(''), '你好呀，今天也陪着你。');
  queue.dispose();
  const short: string[] = [];
  const next = createCustomSpeechQueue({
    failure: () => assert.fail(),
    sink: {
      synthesize: async (text) => {
        short.push(text);
        return new Blob([text]);
      },
      play: async () => {},
    },
  });
  next.begin();
  next.append('好！');
  await tick();
  assert.deepEqual(short, ['好！']);
  next.dispose();
});

test('首句持续出字也有固定等待上限，不被每个新增字反复推迟，打断清理计时器', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested: string[] = [];
  const queue = createCustomSpeechQueue({
    failure: () => assert.fail(),
    sink: {
      synthesize: async (text) => {
        requested.push(text);
        return new Blob([text]);
      },
      play: async () => {},
    },
  });
  queue.begin();
  queue.append('我来帮你');
  t.mock.timers.tick(80);
  queue.append('看看');
  t.mock.timers.tick(80);
  await tick();
  assert.deepEqual(requested, ['我来帮你看看']);
  queue.begin();
  queue.append('新的内容');
  queue.interrupt();
  t.mock.timers.tick(1000);
  await tick();
  assert.equal(requested.length, 1);
  queue.dispose();
});

test('首句在整轮结束前播放；最多预取两段，并按原顺序完整读完', async () => {
  const requested: string[] = [];
  const played: string[] = [];
  const gates: (() => void)[] = [];
  const queue = createCustomSpeechQueue({
    failure: () => assert.fail('Unexpected failure'),
    sink: {
      synthesize: async (text) => {
        requested.push(text);
        return new Blob([text]);
      },
      play: async (blob) => {
        played.push(await blob.text());
        await new Promise<void>((done) => gates.push(done));
      },
    },
  });
  queue.begin();
  queue.append('你好呀，我已经听到你的话啦。');
  await tick();
  assert.ok(played.length > 0);
  assert.ok(queue.busy());
  queue.append('这是一段比较长的后续回答，需要用完整的句子逐句读出来，后面还有更多内容。');
  queue.finish();
  await tick();
  assert.ok(requested.length <= 2, '播放被挡住时不能无限预取');
  for (let i = 0; i < 12 && queue.busy(); i++) {
    gates.shift()?.();
    await tick();
  }
  assert.equal(
    played.join(''),
    '你好呀，我已经听到你的话啦。这是一段比较长的后续回答，需要用完整的句子逐句读出来，后面还有更多内容。',
  );
  queue.dispose();
});

test('首批文字很短时只等待一次截止时间，后续凑够正文立即合成，最终正文完整且不重读', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested: string[] = [];
  const queue = createCustomSpeechQueue({
    failure: () => assert.fail(),
    sink: {
      synthesize: async (text) => {
        requested.push(text);
        return new Blob([text]);
      },
      play: async () => {},
    },
  });
  queue.begin();
  queue.append('听');
  t.mock.timers.tick(160);
  queue.append('到你');
  await tick();
  assert.deepEqual(requested, []);
  queue.append('啦');
  await tick();
  assert.deepEqual(requested, ['听到你啦']);
  queue.append('，一起聊聊吧。');
  queue.finish();
  await tick();
  assert.equal(requested.join(''), '听到你啦，一起聊聊吧。');
  queue.dispose();
});

test('打断会取消旧轮的合成，迟到结果不播放，新轮仍能发声', async () => {
  let oldSignal: AbortSignal | undefined;
  let release: ((audio: Blob) => void) | undefined;
  const played: string[] = [];
  const queue = createCustomSpeechQueue({
    failure: () => assert.fail('Cancelled work must not fail the new turn'),
    sink: {
      synthesize: (text, signal) => {
        if (text.includes('旧的')) {
          oldSignal = signal;
          return new Promise((done) => {
            release = done;
          });
        }
        return Promise.resolve(new Blob([text]));
      },
      play: async (blob) => {
        played.push(await blob.text());
      },
    },
  });
  queue.begin();
  queue.append('这是旧的回复。');
  queue.finish();
  await tick();
  queue.interrupt();
  assert.equal(oldSignal?.aborted, true);
  queue.begin();
  queue.append('这是新的回复。');
  queue.finish();
  release?.(new Blob(['迟到的旧句']));
  await tick();
  assert.deepEqual(played, ['这是新的回复。']);
  queue.dispose();
});

test('最终完整字幕补齐尾巴但不重读，换轮后不会串音；合成失败明确回调', async () => {
  const played: string[] = [];
  let failures = 0;
  const queue = createCustomSpeechQueue({
    failure: () => {
      failures++;
    },
    sink: {
      synthesize: async (text) => {
        if (text.includes('失败')) throw Error('test');
        return new Blob([text]);
      },
      play: async (blob) => {
        played.push(await blob.text());
      },
    },
  });
  queue.begin();
  queue.append('这是一句完整的话。');
  await tick();
  queue.finish('这是一句完整的话。还有结尾😀。');
  await tick();
  assert.equal(played.join(''), '这是一句完整的话。还有结尾😀。');
  queue.begin();
  queue.append('这次合成失败。');
  queue.finish();
  await tick();
  assert.equal(failures, 1);
  assert.equal(queue.busy(), false);
  queue.dispose();
});

test('迟到的单独标点和表情不调用合成，不会令正常语音聊天中断', async () => {
  const spoken: string[] = [];
  const queue = createCustomSpeechQueue({
    failure: () => assert.fail('Punctuation must not fail synthesis'),
    sink: {
      synthesize: async (text) => {
        assert.match(text, /[\p{L}\p{N}]/u);
        spoken.push(text);
        return new Blob([text]);
      },
      play: async () => {},
    },
  });
  queue.begin();
  queue.append('已经听到你的消息。');
  await tick();
  queue.append('。😀');
  queue.finish();
  await tick();
  assert.deepEqual(spoken, ['已经听到你的消息。']);
  queue.dispose();
});
