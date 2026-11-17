/** 显式启用的桌面选择验收：真实应用、离屏静音、独立配置，两次进程启动。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'single and multiple desktop pets persist across a real application restart',
  {
    skip:
      process.platform !== 'win32' ||
      process.env.DSH_PET_SELECTION_LIVE !== '1' ||
      !process.env.DSH_PET_NATIVE_LIVE_ELECTRON ||
      !process.env.DSH_PET_NATIVE_COMPANION_ASAR ||
      !process.env.DSH_PET_SELECTION_PACK,
  },
  async () => {
    const run = await mkdtemp(join(tmpdir(), 'pet-selection-native-'));
    const folder = join(run, 'home/dsh-pet');
    await mkdir(folder, { recursive: true });
    await cp(resolve(process.env.DSH_PET_SELECTION_PACK), join(folder, 'pet'), { recursive: true });
    const packFile = join(folder, 'pet/maixiaowen-config.json');
    const pack = JSON.parse(await readFile(packFile, 'utf8'));
    Object.assign(pack.pets[0], { display: 'desktop', balanceEnabled: false, workStatusEnabled: false });
    await writeFile(packFile, JSON.stringify(pack));
    await writeFile(
      join(folder, 'main-config.jsonc'),
      JSON.stringify({
        pets: [
          {
            id: 'main',
            name: '原大肥鱼',
            display: 'none',
            balanceEnabled: false,
            whisperEnabled: false,
            workStatusEnabled: false,
          },
        ],
        trayEnabled: false,
        voiceEnabled: false,
        voiceVolume: 0,
        clickSoundEnabled: false,
      }),
    );
    await writeFile(join(folder, 'memory.json'), '{}');
    await mkdir(join(folder, 'long-term-memory'));
    await writeFile(join(folder, 'long-term-memory/preservation-fixture.json'), '{"fixture":"keep"}');
    let allOutput = '';
    try {
      for (const phase of ['switch', 'restart']) {
        const env = {
          ...process.env,
          DSH_HOME: join(run, 'home'),
          DSH_PET_CODEX_OBSERVE: '0',
          DSH_PET_TASKBAR_WATCHDOG: '0',
          FISH_TEST_RUN: run,
          PET_SELECTION_PHASE: phase,
        };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = spawn(
          env.DSH_PET_NATIVE_LIVE_ELECTRON,
          [fileURLToPath(new URL('./fixtures/pet-selection.cjs', import.meta.url))],
          { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        child.stdout.on('data', (v) => (allOutput += v));
        child.stderr.on('data', (v) => (allOutput += v));
        const code = await new Promise((done, reject) => {
          const timer = setTimeout(() => {
            child.kill();
            reject(Error('isolated selection test deadline'));
          }, 90000);
          child.once('error', (e) => {
            clearTimeout(timer);
            reject(e);
          });
          child.once('exit', (value) => {
            clearTimeout(timer);
            done(value);
          });
        });
        const result = JSON.parse(await readFile(join(run, phase + '.json'), 'utf8'));
        assert.equal(result.ok, true, result.error);
        assert.equal(code, 0);
        assert.equal(result.shown, false);
        assert.equal(result.dialogs, 0);
      }
      if (process.env.DSH_PET_SELECTION_CHAT === '1') {
        const memory = JSON.parse(await readFile(join(folder, 'memory.json'), 'utf8'));
        assert.deepEqual(Object.keys(memory), ['maixiaowen']);
      } else assert.equal(await readFile(join(folder, 'memory.json'), 'utf8'), '{}');
      assert.equal(
        await readFile(join(folder, 'long-term-memory/preservation-fixture.json'), 'utf8'),
        '{"fixture":"keep"}',
      );
    } finally {
      if (process.env.DSH_PET_SELECTION_EVIDENCE) {
        const evidence = resolve(process.env.DSH_PET_SELECTION_EVIDENCE);
        await mkdir(evidence, { recursive: true });
        for (const name of ['switch.json', 'restart.json', 'pet-selection-390.png', 'pet-target-chat.png']) {
          const bytes = await readFile(join(run, name)).catch(() => null);
          if (bytes) await writeFile(join(evidence, name), bytes);
        }
        await writeFile(join(evidence, 'native.log'), allOutput);
      }
      assert.ok(resolve(run).startsWith(resolve(tmpdir()) + sep));
      await rm(run, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 });
    }
  },
);
