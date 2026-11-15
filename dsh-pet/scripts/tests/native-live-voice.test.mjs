/** 显式启用才调用现有 Codex 账号；全程离屏、静音、合成麦克风，不碰玩家存档。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'native realtime voice returns audible PCM and captions; end/cancel release microphone and preserve draft',
  {
    skip:
      process.platform !== 'win32' ||
      !process.env.DSH_PET_NATIVE_LIVE_ELECTRON ||
      !process.env.DSH_PET_NATIVE_COMPANION_ASAR,
  },
  async () => {
    const run = await mkdtemp(join(tmpdir(), 'codex-fish-live-'));
    await mkdir(join(run, 'home/dsh-pet'), { recursive: true });
    await writeFile(
      join(run, 'home/dsh-pet/main-config.jsonc'),
      JSON.stringify({
        pets: [{ id: 'main', display: 'desktop', whisperEnabled: false, balanceEnabled: false }],
        trayEnabled: false,
        voiceEnabled: true,
        voiceVolume: 0,
        speechProvider: 'codex',
        clickSoundEnabled: false,
      }),
    );
    const env = {
      ...process.env,
      DSH_HOME: join(run, 'home'),
      DSH_PET_CODEX_OBSERVE: '0',
      DSH_PET_TASKBAR_WATCHDOG: '0',
      FISH_TEST_RUN: run,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      resolve(env.DSH_PET_NATIVE_LIVE_ELECTRON),
      [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/native-live-voice.cjs')],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (value) => {
      output += value;
    });
    child.stderr.on('data', (value) => {
      output += value;
    });
    try {
      await new Promise((done, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(Error('即时语音离屏验收超时'));
        }, 160000);
        child.once('error', (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.once('exit', () => {
          clearTimeout(timer);
          done();
        });
      });
      const report = JSON.parse(await readFile(join(run, 'result.json'), 'utf8'));
      assert.equal(report.ok, true, report.error);
      assert.equal(report.shown, false);
      assert.equal(report.connected, true);
      assert.equal(report.hostReleased, true);
      assert.equal(report.memoryUntouched, true);
      assert.equal(report.cancelled, true);
      assert.match(report.dictation, /测试/);
      assert.equal(report.savedClearedDirty, true);
      assert.equal(report.savedClosed, true);
      assert.equal(report.cancelCloseKeptWindow, true);
      assert.equal(report.discardClosed, true);
      assert.ok(report.live.peak > 0.001);
      assert.equal(report.bargeInStoppedOld, true);
      assert.equal(report.nativeDirect, true);
      assert.equal(report.rememberedTone, 'dango');
      for (const id of ['starbell-v1', 'sugarbud-v1', 'dango-v1'])
        assert.ok(report.custom.played.includes('bigfish-cute/' + id));
      for (const id of ['starbell-v1', 'sugarbud-v1', 'dango-v1'])
        assert.ok(
          report.custom.metrics.some(
            (row) => row.voice === 'bigfish-cute/' + id && Number.isFinite(row.fromSpeechEndMs),
          ),
          'Each voice needs an actual response after the synthetic user finishes',
        );
      assert.ok(report.custom.warmRequests.some((row) => row.active && row.prepared));
    } finally {
      if (child.exitCode === null) child.kill();
      if (env.DSH_PET_NATIVE_LIVE_EVIDENCE) {
        const evidence = resolve(env.DSH_PET_NATIVE_LIVE_EVIDENCE);
        await mkdir(evidence, { recursive: true });
        await writeFile(join(evidence, 'native-live.log'), output);
        for (const file of [
          'result.json',
          'live-offscreen.png',
          'native-sweet-voice.wav',
          'starbell-v1.mp3',
          'sugarbud-v1.mp3',
          'dango-v1.mp3',
        ]) {
          const data = await readFile(join(run, file)).catch(() => null);
          if (data) await writeFile(join(evidence, file), data);
        }
      }
      assert.ok(resolve(run).startsWith(resolve(tmpdir()) + sep));
      await rm(run, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  },
);
