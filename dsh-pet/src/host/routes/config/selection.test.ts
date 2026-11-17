import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readAllConfig } from '../../config.ts';
import type { PetRouteDeps, RouteInput } from '../types.ts';
import { savePetSelection, writeSelectionFiles } from './selection.ts';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'pet-selection-'));
  const petDir = join(root, 'pet');
  mkdirSync(petDir);
  const userFile = join(root, 'main-config.jsonc');
  const packFile = join(petDir, 'mai-config.json');
  const pet = (id: string, display: string) => ({
    id,
    name: id,
    size: 300,
    display,
    position: { corner: 'bottom-right', marginX: 20, marginY: 20 },
  });
  writeFileSync(
    userFile,
    JSON.stringify({ pets: [pet('main', 'both')], voiceName: 'test/unchanged', custom: { keep: true } }),
  );
  writeFileSync(
    packFile,
    JSON.stringify({ pets: [pet('mai', 'none')], whisperPrompt: 'keep persona', custom: { pack: true } }),
  );
  const memory = join(root, 'memory.json');
  writeFileSync(memory, '{"private-test-history":1}');
  const configPaths = {
    defaultFile: fileURLToPath(new URL('../../../../assets/config.jsonc', import.meta.url)),
    userFile,
    petDir,
  };
  let restarts = 0;
  const deps = {
    configPaths,
    userRoot: root,
    userConfigPath: userFile,
    petConfigDir: petDir,
    state: { writeSection() {} },
    lock: { release() {} },
    requestRestart: async () => {
      restarts++;
    },
  } as unknown as PetRouteDeps;
  const request = async (body: unknown, method = 'POST') => {
    const response = await savePetSelection(deps, {
      method,
      rest: 'pet-selection',
      url: new URL('http://localhost/pet-selection'),
      body: JSON.stringify(body),
    } as RouteInput);
    assert.equal(response.kind, 'json');
    if (response.kind !== 'json') throw Error('not json');
    return response;
  };
  return {
    root,
    userFile,
    packFile,
    memory,
    configPaths,
    request,
    restarts: () => restarts,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('单宠跨种类切换只保留一只桌面宠物，保留浏览器显示、人设、音色及聊天', async () => {
  const f = fixture();
  try {
    const r = await f.request({ mode: 'single', ids: ['mai'] });
    assert.equal(r.status, 200);
    const c = readAllConfig(f.configPaths);
    assert.equal(c.main.desktopPetMode, 'single');
    assert.equal((c.main.pets as { display: string }[])[0].display, 'web');
    assert.equal((c.mai.pets as { display: string }[])[0].display, 'desktop');
    assert.equal(JSON.parse(readFileSync(f.userFile, 'utf8')).voiceName, 'test/unchanged');
    assert.deepEqual(JSON.parse(readFileSync(f.userFile, 'utf8')).custom, { keep: true });
    assert.equal(JSON.parse(readFileSync(f.packFile, 'utf8')).whisperPrompt, 'keep persona');
    assert.equal(readFileSync(f.memory, 'utf8'), '{"private-test-history":1}');
    assert.equal(f.restarts(), 1);
  } finally {
    f.cleanup();
  }
});

test('多宠可同时显示两只，选一只时也记住多宠模式；再切单宠可重新读取', async () => {
  const f = fixture();
  try {
    await f.request({ mode: 'multiple', ids: ['main', 'mai'] });
    let c = readAllConfig(f.configPaths);
    assert.equal(c.main.desktopPetMode, 'multiple');
    assert.equal((c.main.pets as { display: string }[])[0].display, 'both');
    assert.equal((c.mai.pets as { display: string }[])[0].display, 'desktop');
    await f.request({ mode: 'multiple', ids: ['mai'] });
    assert.equal(readAllConfig(f.configPaths).main.desktopPetMode, 'multiple');
    await f.request({ mode: 'single', ids: ['main'] });
    c = readAllConfig(f.configPaths);
    assert.equal(c.main.desktopPetMode, 'single');
    assert.equal((c.mai.pets as { display: string }[])[0].display, 'none');
  } finally {
    f.cleanup();
  }
});

test('非法模式、空选择、重复、未知角色与单宠多选在写入前拒绝', async () => {
  const f = fixture();
  try {
    const before = readFileSync(f.userFile);
    for (const body of [
      null,
      {},
      { mode: 'bad', ids: ['main'] },
      { mode: 'single', ids: [] },
      { mode: 'multiple', ids: ['main', 'main'] },
      { mode: 'single', ids: ['main', 'mai'] },
      { mode: 'single', ids: ['missing'] },
    ]) {
      const r = await f.request(body);
      assert.equal((r.obj as { ok: boolean }).ok, false);
      assert.ok(readFileSync(f.userFile).equals(before));
    }
    assert.equal(f.restarts(), 0);
    assert.equal((await f.request({}, 'GET')).status, 405);
  } finally {
    f.cleanup();
  }
});

test('损坏的用户配置不会被切换操作重建覆盖', async () => {
  const f = fixture();
  try {
    writeFileSync(f.userFile, '{ damaged');
    const r = await f.request({ mode: 'single', ids: ['mai'] });
    assert.equal((r.obj as { reason: string }).reason, 'user-config-unparsable');
    assert.equal(readFileSync(f.userFile, 'utf8'), '{ damaged');
  } finally {
    f.cleanup();
  }
});

test('第二个文件替换失败时，已写文件恢复原始字节，清理暂存文件', async () => {
  const f = fixture();
  try {
    const before = [readFileSync(f.userFile), readFileSync(f.packFile)];
    let calls = 0;
    await assert.rejects(
      writeSelectionFiles(
        [
          { path: f.userFile, data: 'changed' },
          { path: f.packFile, data: 'changed' },
        ],
        async (a, b) => {
          if (++calls === 2) throw Error('test injected failure');
          await rename(a, b);
        },
      ),
      /test injected failure/,
    );
    assert.ok(readFileSync(f.userFile).equals(before[0]));
    assert.ok(readFileSync(f.packFile).equals(before[1]));
    assert.ok(!readdirSync(f.root).some((n) => n.includes('.selection-')));
    assert.ok(!readdirSync(join(f.root, 'pet')).some((n) => n.includes('.selection-')));
  } finally {
    f.cleanup();
  }
});
