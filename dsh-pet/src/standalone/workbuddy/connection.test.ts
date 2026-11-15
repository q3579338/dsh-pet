import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkBuddyConnection } from './connection.ts';
const fixture = fileURLToPath(new URL('../../../scripts/tests/fixtures/workbuddy-native.cjs', import.meta.url));
for (const mode of ['ok', 'auth', 'hang'])
  test('WorkBuddy 真实独立管道：' + mode, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'fish-workbuddy-'));
    const connection = createWorkBuddyConnection(folder, () => ({
      file: process.execPath,
      args: [fixture],
      env: { ...process.env, FISH_CLI_MODE: mode },
    }));
    try {
      const models = await connection.models();
      assert.equal(models.length, 3);
      const collect = async () => {
        let text = '';
        for await (const part of connection.stream(
          'deepseek-v4-flash',
          { system: '保留角色设定', messages: [{ role: 'user', content: '你好' }] },
          AbortSignal.timeout(mode === 'hang' ? 250 : 10000),
        ))
          text += part.text ?? '';
        return text;
      };
      if (mode === 'ok') assert.equal(await collect(), '大肥鱼来啦！');
      else await assert.rejects(collect(), mode === 'auth' ? /登录/u : /已停止/u);
      assert.deepEqual(readdirSync(join(folder, 'workbuddy-chat')), []);
    } finally {
      connection.dispose();
      assert.ok(resolve(folder).startsWith(resolve(tmpdir()) + sep));
      rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
