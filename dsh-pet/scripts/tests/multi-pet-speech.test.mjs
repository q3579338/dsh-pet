/** 多只真实桌宠分别发声；窗口强制离屏静音，数据使用独立目录。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, cp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'three desktop pets including a same-kind clone each play their own replies while occluded',
  {
    skip:
      process.platform !== 'win32' ||
      process.env.DSH_PET_MULTI_SPEECH !== '1' ||
      !process.env.DSH_PET_NATIVE_LIVE_ELECTRON ||
      !process.env.DSH_PET_NATIVE_COMPANION_ASAR ||
      !process.env.DSH_PET_SELECTION_PACK,
  },
  async () => {
    const run = await mkdtemp(join(tmpdir(), 'pet-multi-speech-'));
    const folder = join(run, 'home/dsh-pet');
    await mkdir(folder, { recursive: true });
    await cp(resolve(process.env.DSH_PET_SELECTION_PACK), join(folder, 'pet'), { recursive: true });
    const file = join(folder, 'pet/maixiaowen-config.json');
    const pack = JSON.parse(await readFile(file, 'utf8'));
    Object.assign(pack.pets[0], {
      display: 'desktop',
      whisperEnabled: false,
      balanceEnabled: false,
      workStatusEnabled: false,
    });
    await writeFile(file, JSON.stringify(pack));
    await writeFile(
      join(folder, 'main-config.jsonc'),
      JSON.stringify({
        desktopPetMode: 'multiple',
        pets: ['main', 'main-2'].map((id) => ({
          id,
          display: 'desktop',
          whisperEnabled: false,
          balanceEnabled: false,
          workStatusEnabled: false,
        })),
        trayEnabled: false,
        clickSoundEnabled: false,
        voiceEnabled: true,
        voiceWhisperEnabled: false,
        voiceName: process.env.DSH_PET_MULTI_TEST_VOICE || 'bigfish-cute/starbell-v1',
        voiceVolume: 0,
      }),
    );
    await writeFile(join(folder, 'memory.json'), '{}');
    const env = {
      ...process.env,
      DSH_HOME: join(run, 'home'),
      FISH_TEST_RUN: run,
      DSH_PET_CODEX_OBSERVE: '0',
      DSH_PET_TASKBAR_WATCHDOG: '0',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      env.DSH_PET_NATIVE_LIVE_ELECTRON,
      [fileURLToPath(new URL('./fixtures/multi-pet-speech.cjs', import.meta.url))],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (data) => (output += data));
    child.stderr.on('data', (data) => (output += data));
    try {
      const code = await new Promise((done, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(Error('Isolated multi-pet speech deadline'));
        }, 180000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timer);
          done(code);
        });
      });
      const report = JSON.parse(await readFile(join(run, 'result.json'), 'utf8'));
      assert.equal(report.ok, true, report.error);
      assert.equal(code, 0);
      assert.equal(report.shown, false);
      assert.equal(report.pets.length, 3);
      for (const pet of report.pets) {
        assert.equal(pet.initialPlays, 1, pet.id);
        assert.ok(pet.plays >= 1, pet.id);
        assert.ok(pet.nonSilentAudio, pet.id);
      }
      if (env.DSH_PET_MULTI_CHAT === '1') assert.equal(report.chatReplies.length, 3);
      assert.equal(report.occludedDuringSynthesis, true);
    } finally {
      if (child.exitCode === null) child.kill();
      if (env.DSH_PET_MULTI_SPEECH_EVIDENCE) {
        const evidence = resolve(env.DSH_PET_MULTI_SPEECH_EVIDENCE);
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, 'native.log'), output);
        const bytes = await readFile(join(run, 'result.json')).catch(() => null);
        if (bytes) await writeFile(join(evidence, 'result.json'), bytes);
      }
      assert.ok(resolve(run).startsWith(resolve(tmpdir()) + sep));
      await rm(run, { recursive: true, force: true, maxRetries: 15, retryDelay: 50 });
    }
  },
);
