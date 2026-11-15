/** 流式服务实际交付首字节，不提前发布半截缓存，多个订阅者各自拥有取消权。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerVoiceProvider, resetVoiceProviders } from './registry.ts';
import { createVoiceService, type VoiceService } from './speak.ts';
import type { SynthInput } from './types.ts';

/** 人工闸门使“首字节早于完成”的断言不依赖机器速度。 */
function gate() {
  let open!: () => void;
  const ready = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { ready, open };
}
/** 完全隔离的数据目录与上游生成器。 */
async function withStream(
  render: (input: SynthInput) => AsyncIterable<Uint8Array>,
  run: (service: VoiceService) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'bigfish-stream-'));
  registerVoiceProvider({
    id: 'stream',
    name: 'Test',
    voices: [{ id: 'a', name: 'A' }],
    stream: render,
    synthesize: async () => {
      throw new Error('Must use the same streaming synthesis');
    },
  });
  try {
    await run(createVoiceService({ userRoot: root, configuredVoice: () => 'stream/a' }));
  } finally {
    resetVoiceProviders();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
}

test('首字节可在上游完成前读取；完整请求与多个流订阅只合成一次，缓存字节完全相同', async () => {
  const last = gate();
  let calls = 0;
  await withStream(
    async function* () {
      calls++;
      yield new Uint8Array([1, 2]);
      await last.ready;
      yield new Uint8Array([3]);
    },
    async (service) => {
      const first = await service.stream!({ text: '第一批声音' });
      assert.ok(first.ok && 'stream' in first);
      const reader = first.stream[Symbol.asyncIterator]();
      assert.deepEqual((await reader.next()).value, new Uint8Array([1, 2]));
      const whole = service.speak({ text: '第一批声音' });
      const second = await service.stream!({ text: '第一批声音' });
      assert.ok(second.ok && 'stream' in second);
      last.open();
      const chunks: number[] = [];
      for await (const chunk of second.stream) chunks.push(...chunk);
      assert.deepEqual(chunks, [1, 2, 3]);
      assert.deepEqual((await reader.next()).value, new Uint8Array([3]));
      assert.equal((await reader.next()).done, true);
      const result = await whole;
      assert.ok(result.ok);
      assert.deepEqual([...(await readFile(result.file))], [1, 2, 3]);
      assert.equal(calls, 1);
      const cached = await service.stream!({ text: '第一批声音' });
      assert.ok(cached.ok && 'file' in cached);
      assert.equal(calls, 1);
    },
  );
});

test('关闭一个流不取消另一订阅；最后一个订阅取消立即中止上游', async () => {
  const final = gate();
  let upstream: AbortSignal | undefined;
  await withStream(
    async function* ({ signal }) {
      upstream = signal;
      yield new Uint8Array([1]);
      await final.ready;
    },
    async (service) => {
      const a = new AbortController();
      const first = await service.stream!({ text: '共享取消' }, a.signal);
      const second = await service.stream!({ text: '共享取消' });
      assert.ok(first.ok && 'stream' in first && second.ok && 'stream' in second);
      a.abort();
      assert.equal(upstream?.aborted, false);
      second.dispose();
      assert.equal(upstream?.aborted, true);
      final.open();
    },
  );
});

test('首字节前错误返回受控失败；已经交付字节的错误终止流且不缓存半截', async () => {
  let calls = 0;
  await withStream(
    async function* ({ text }) {
      calls++;
      if (text === '部分失败') yield new Uint8Array([1]);
      throw new Error('private upstream detail');
    },
    async (service) => {
      const failed = await service.stream!({ text: '初始失败' });
      assert.ok(!failed.ok);
      assert.equal(failed.reason, 'generate-error');
      assert.doesNotMatch(failed.message, /private/);
      for (let repeat = 0; repeat < 2; repeat++) {
        const partial = await service.stream!({ text: '部分失败' });
        assert.ok(partial.ok && 'stream' in partial);
        await assert.rejects(async () => {
          for await (const chunk of partial.stream) {
            assert.ok(chunk.length);
          }
        }, /stream failed/);
        partial.dispose();
      }
      assert.equal(calls, 3);
    },
  );
});
