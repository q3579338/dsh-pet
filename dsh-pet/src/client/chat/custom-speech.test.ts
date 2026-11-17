import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCustomSpeechQueue } from './custom-speech.ts';
import { createAssistantTranscript } from './live-transcript.ts';

/** 让队列的 Promise 链完成一轮，不需要真实计时或音频设备。 */
async function tick(): Promise<void> {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

test('真实朗读队列只合成一次双路字幕，日期数字不结巴、不在最终字幕到来时重念', async () => {
  const requested: string[] = [],
    played: string[] = [];
  const stream = createAssistantTranscript();
  const queue = createCustomSpeechQueue({
    failure: () => assert.fail(),
    sink: {
      synthesize: async (text) => {
        requested.push(text);
        return new Blob([text]);
      },
      play: async (audio) => {
        assert.ok(audio instanceof Blob);
        played.push(await audio.text());
      },
    },
  });
  const accept = (event: Record<string, unknown>) => {
    const row = stream.accept(event);
    if (row.begin) queue.begin();
    if (row.delta) queue.append(row.delta);
    if (row.done) queue.finish(row.full);
  };
  try {
    accept({ type: 'turn.created', turn: { id: 'a', role: 'assistant' } });
    const words = ['今天是', '2026', '年', '11', '月', '16', '日，', '星期一。'];
    for (let i = 0; i < words.length; i++) {
      accept({ type: 'turn.delta', turn_id: 'a', delta: words[i] });
      accept({ type: 'output_transcript.added', item: { id: 'p' + i, text: words[i] } });
      await tick();
    }
    accept({ type: 'turn.done', turn: { id: 'a', role: 'assistant', transcript: words.join('') } });
    for (let i = 0; i < 4; i++) await tick();
    assert.equal(requested.join(''), words.join(''));
    assert.equal(played.join(''), words.join(''));
    assert.equal(requested.filter((text) => text.includes('2026')).length, 1);
  } finally {
    queue.dispose();
  }
});

test('问候语碎片合并成完整短句，不能把嗨、你好拆成多段造成结巴', async () => {
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
  try {
    queue.begin();
    queue.append('嗨，');
    await tick();
    queue.append('你好！');
    await tick();
    assert.deepEqual(requested, []);
    queue.append('想聊点什么或者需要我帮你做点什么吗？');
    queue.finish();
    await tick();
    assert.deepEqual(requested, ['嗨，你好！想聊点什么或者需要我帮你做点什么吗？']);
  } finally {
    queue.dispose();
  }
});

test('短问候不抢先拆开，完整回答确认后立即朗读且正文不丢失', async () => {
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
  assert.deepEqual(requested, []);
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
  assert.deepEqual(short, []);
  next.finish();
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
  queue.append('我来帮你看看这个问题应该如何处理');
  t.mock.timers.tick(200);
  queue.append('得更顺畅');
  t.mock.timers.tick(200);
  await tick();
  assert.deepEqual(requested, ['我来帮你看看这个问题应该如何处理得更顺畅']);
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

test('后段缓存先返回时仍等待首段，严格按台词顺序各播放一次', async () => {
  const requested: string[] = [],
    played: string[] = [],
    completed: string[] = [];
  let releaseFirst!: () => void;
  const queue = createCustomSpeechQueue({
    failure: () => assert.fail('Unexpected failure'),
    sink: {
      synthesize: async (text) => {
        requested.push(text);
        if (requested.length === 1) await new Promise<void>((done) => (releaseFirst = done));
        completed.push(text);
        return new Blob([text]);
      },
      play: async (audio) => {
        played.push(await audio.text());
      },
    },
  });
  try {
    queue.begin();
    queue.append('这就展示给你看，记忆测试星！');
    queue.append('天圆地方，亮相～');
    queue.finish();
    await tick();
    assert.equal(requested.length, 2);
    assert.deepEqual(completed, [requested[1]]);
    assert.deepEqual(played, []);
    releaseFirst();
    for (let i = 0; i < 5 && queue.busy(); i++) await tick();
    assert.deepEqual(completed, [requested[1], requested[0]]);
    assert.deepEqual(played, requested);
    assert.equal(played.join(''), '这就展示给你看，记忆测试星！天圆地方，亮相～');
  } finally {
    queue.dispose();
  }
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
  t.mock.timers.tick(400);
  queue.append('到你');
  await tick();
  assert.deepEqual(requested, []);
  queue.append('啦');
  await tick();
  assert.deepEqual(requested, []);
  queue.append('，我们可以一起慢慢聊聊今天的事情');
  await tick();
  assert.equal(requested.length, 1);
  queue.append('，一起聊聊吧。');
  queue.finish();
  await tick();
  assert.equal(requested.join(''), '听到你啦，我们可以一起慢慢聊聊今天的事情，一起聊聊吧。');
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
