import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkBuddySession } from './session.ts';

test('同一通连续语音复用自己的后台进程；打断后重建，错位事件不泄露原文', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-wb-pool-'));
  const session = createWorkBuddySession(
    () => ({ file: process.execPath, args: [], env: process.env }),
    fileURLToPath(new URL('../../../scripts/tests/fixtures/workbuddy-session.cjs', import.meta.url)),
    home,
  );
  const collect = async (input: unknown, signal = AbortSignal.timeout(5000)) => {
    let text = '';
    for await (const line of session.run(input, signal)) {
      const event = JSON.parse(line);
      if (event.type === 'text') text += event.text;
    }
    return text;
  };
  try {
    const first = await collect({ action: 'chat' });
    assert.match(first, /^大肥鱼\d+$/u);
    assert.equal(await collect({ action: 'chat' }), first);
    await assert.rejects(collect({ mode: 'hang' }, AbortSignal.timeout(100)), /已停止/u);
    assert.notEqual(await collect({ action: 'chat' }), first);
    await assert.rejects(
      collect({ mode: 'invalid' }),
      (error) => error instanceof Error && !error.message.includes('private'),
    );
    assert.match(await collect({ action: 'chat' }), /^大肥鱼\d+$/u);
    session.dispose();
    await assert.rejects(collect({ action: 'chat' }));
  } finally {
    session.dispose();
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
