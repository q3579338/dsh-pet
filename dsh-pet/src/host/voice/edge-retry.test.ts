import assert from 'node:assert/strict';
import { test } from 'node:test';
import { retryVoiceRateLimit } from './edge.ts';

test('仅临时 429 有界退避，不重放权限错误或永久循环', async () => {
  let calls = 0;
  const waits: number[] = [];
  assert.equal(
    await retryVoiceRateLimit(
      async () => {
        if (++calls < 3) throw Error('HTTP 429');
        return 'ok';
      },
      undefined,
      async (ms) => {
        waits.push(ms);
      },
    ),
    'ok',
  );
  assert.deepEqual(waits, [1000, 2500]);
  for (const status of [403, 500]) {
    calls = 0;
    await assert.rejects(
      retryVoiceRateLimit(
        async () => {
          calls++;
          throw Error('HTTP ' + status);
        },
        undefined,
        async () => assert.fail('Must not retry'),
      ),
    );
    assert.equal(calls, 1);
  }
  calls = 0;
  await assert.rejects(
    retryVoiceRateLimit(
      async () => {
        calls++;
        throw Error('HTTP 429');
      },
      undefined,
      async () => {},
    ),
  );
  assert.equal(calls, 3);
});

test('取消退避不再开始下一次合成', async () => {
  const abort = new AbortController();
  let calls = 0;
  await assert.rejects(
    retryVoiceRateLimit(
      async () => {
        calls++;
        throw Error('HTTP 429');
      },
      abort.signal,
      async () => {
        abort.abort();
      },
    ),
  );
  assert.equal(calls, 1);
});
