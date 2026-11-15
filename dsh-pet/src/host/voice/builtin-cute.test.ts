/** 调音预设回归：核对实际传给引擎的声线、音高、语速和取消信号，并保留原版目录。 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { createCuteVoiceProvider, CUTE_VOICES, ensureCuteVoices } from './builtin-cute.ts';
import { EDGE_PROVIDER, ensureEdgeProvider } from './builtin-edge.ts';
import { listCatalog, resetVoiceProviders, resolveVoice } from './registry.ts';
import type { EdgeSynthInput } from './edge.ts';

afterEach(resetVoiceProviders);

test('流式和完整音频使用完全相同的真实音色、音高与节奏', async () => {
  const calls: EdgeSynthInput[] = [];
  const provider = createCuteVoiceProvider(
    async (input) => {
      calls.push(input);
      return new Uint8Array([1]);
    },
    async function* (input) {
      calls.push(input);
      yield new Uint8Array([1]);
    },
  );
  for (const preset of CUTE_VOICES) {
    const signal = new AbortController().signal;
    const input = { text: '不要改变音色', voice: preset.id, rate: 7, signal };
    await provider.synthesize(input);
    for await (const chunk of provider.stream!(input)) {
      assert.ok(chunk.length);
    }
    assert.deepEqual(calls[calls.length - 1], calls[calls.length - 2]);
  }
});

test('四种风格确实将基底声线、音高和节奏传给引擎', async () => {
  const calls: EdgeSynthInput[] = [];
  const bytes = new Uint8Array([7, 3]);
  const provider = createCuteVoiceProvider(async (input) => {
    calls.push(input);
    return bytes;
  });
  for (const voice of ['starbell-v1', 'moon-soft-v1', 'sugarbud-v1', 'dango-v1'])
    assert.equal(await provider.synthesize({ text: '我来啦！', voice, rate: 0 }), bytes);
  assert.deepEqual(
    calls.map(({ voice, pitch, rate }) => ({ voice, pitch, rate })),
    [
      { voice: 'zh-CN-XiaoyiNeural', pitch: 18, rate: 6 },
      { voice: 'zh-CN-XiaoxiaoNeural', pitch: 8, rate: -8 },
      { voice: 'zh-CN-XiaoyiNeural', pitch: 38, rate: -7 },
      { voice: 'zh-CN-XiaoxiaoNeural', pitch: 48, rate: 5 },
    ],
  );
});

test('请求语速叠加预设节奏后仍受服务支持范围约束', async () => {
  const rates: number[] = [];
  const provider = createCuteVoiceProvider(async ({ rate }) => {
    rates.push(rate);
    return new Uint8Array([1]);
  });
  for (const [voice, rate] of [
    ['starbell-v1', 100],
    ['moon-soft-v1', -50],
    ['moon-soft-v1', 10],
  ] as const)
    await provider.synthesize({ text: '你好', voice, rate });
  assert.deepEqual(rates, [100, -50, 2]);
});

test('不存在的预设不调用引擎，也不冒充其他音色', async () => {
  let called = false;
  const provider = createCuteVoiceProvider(async () => {
    called = true;
    return new Uint8Array([1]);
  });
  await assert.rejects(provider.synthesize({ text: '你好', voice: 'missing', rate: 0 }), /没有找到/);
  assert.equal(called, false);
});

test('取消信号和引擎异常沿用现有服务链路', async () => {
  const controller = new AbortController();
  const failure = new Error('engine unavailable');
  const provider = createCuteVoiceProvider(async (input) => {
    assert.equal(input.signal, controller.signal);
    assert.equal(input.text, '不要改写这段文字');
    throw failure;
  });
  await assert.rejects(
    provider.synthesize({ text: '不要改写这段文字', voice: 'sugarbud-v1', rate: 0, signal: controller.signal }),
    (error) => error === failure,
  );
});

test('原创调音独立登记，原版音色与配置 id 保持有效', () => {
  ensureEdgeProvider();
  ensureCuteVoices();
  ensureCuteVoices();
  assert.equal(resolveVoice('edge/zh-CN-XiaoyiNeural')?.provider, EDGE_PROVIDER);
  assert.equal(listCatalog().providers.find((provider) => provider.id === 'bigfish-cute')?.voices.length, 4);
  for (const preset of CUTE_VOICES) assert.ok(resolveVoice('bigfish-cute/' + preset.id));
  assert.equal(listCatalog().providers.filter((provider) => provider.id === 'bigfish-cute').length, 1);
});
