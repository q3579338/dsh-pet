import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createWorkBuddyDictation } from './dictation.ts';
for (const mode of ['ok', 'hang', 'error'])
  test('WorkBuddy 原生识别管道：' + mode, async () => {
    const home = mkdtempSync(join(tmpdir(), 'fish-wb-asr-'));
    const partial: string[] = [];
    try {
      const opened = createWorkBuddyDictation(
        home,
        (text) => partial.push(text),
        AbortSignal.timeout(mode === 'hang' ? 150 : 3000),
        {
          command: () => ({ file: process.execPath, args: [], env: { ...process.env, FISH_ASR_MODE: mode } }),
          worker: fileURLToPath(new URL('../../../scripts/tests/fixtures/workbuddy-asr.cjs', import.meta.url)),
        },
      );
      if (mode === 'hang') {
        await assert.rejects(opened);
        return;
      }
      const stream = await opened;
      try {
        assert.equal(stream.available?.(), true);
        stream.append(new Uint8Array([1, 2, 3, 4]));
        const final = stream.finish();
        if (mode === 'error')
          await assert.rejects(
            final,
            (error) => error instanceof Error && /登录/u.test(error.message) && !error.message.includes('secret'),
          );
        else {
          assert.equal(await final, '测试。');
          assert.deepEqual(partial, ['测试']);
        }
        assert.equal(stream.available?.(), false);
      } finally {
        stream.dispose();
      }
      assert.deepEqual(readdirSync(join(home, 'workbuddy-voice')), []);
    } finally {
      assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
      rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
