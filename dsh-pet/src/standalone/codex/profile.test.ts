import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedCodexProfile } from './profile.ts';

test('Codex first launch preserves the original character and existing user choices', async () => {
  const root = mkdtempSync(join(tmpdir(), 'codex-fish-profile-'));
  const previous = process.env.DSH_PET_CODEX;
  process.env.DSH_PET_CODEX = '1';
  try {
    const paths = {
      defaultFile: join(root, 'base.jsonc'),
      userFile: join(root, 'profile.jsonc'),
      petDir: join(root, 'pet'),
    };
    const original = '{"pets":[{"id":"main","name":"大肥鱼","whisperEnabled":true,"balanceEnabled":true}]}';
    writeFileSync(paths.defaultFile, original);
    seedCodexProfile(paths);
    const seeded = JSON.parse(readFileSync(paths.userFile, 'utf8'));
    assert.deepEqual(seeded.pets, [{ id: 'main', name: '大肥鱼', whisperEnabled: false, balanceEnabled: true }]);
    assert.equal(seeded.eventsRefreshSec.balance, 120);
    assert.equal(readFileSync(paths.defaultFile, 'utf8'), original);
    writeFileSync(
      paths.userFile,
      JSON.stringify({ pets: [{ id: 'main', name: '大肥鱼', whisperEnabled: false, balanceEnabled: false }] }),
    );
    seedCodexProfile(paths);
    assert.equal(JSON.parse(readFileSync(paths.userFile, 'utf8')).pets[0].balanceEnabled, true);
    const chosen = '{"pets":[{"id":"main","whisperEnabled":true}]}';
    writeFileSync(paths.userFile, chosen);
    seedCodexProfile(paths);
    const updated = JSON.parse(readFileSync(paths.userFile, 'utf8'));
    assert.deepEqual(updated.pets, JSON.parse(chosen).pets);
    if (process.platform === 'win32') {
      assert.equal(updated.speechProvider, 'windows');
      assert.equal(updated.voiceName, 'edge/zh-CN-XiaoyiNeural');
      assert.equal(updated.voiceEnabled, true);
    }
    for (const voiceName of [
      'edge/zh-CN-XiaoyiNeural',
      'edge/zh-CN-XiaoxiaoNeural',
      'windows/zh-CN',
      'bigfish-cute/sugarbud-v1',
    ]) {
      const custom = { ...updated, voiceEnabled: false, voiceName, speechProvider: 'custom' };
      writeFileSync(paths.userFile, JSON.stringify(custom));
      seedCodexProfile(paths);
      seedCodexProfile(paths);
      assert.deepEqual(JSON.parse(readFileSync(paths.userFile, 'utf8')), custom);
    }
  } finally {
    if (previous === undefined) delete process.env.DSH_PET_CODEX;
    else process.env.DSH_PET_CODEX = previous;
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
