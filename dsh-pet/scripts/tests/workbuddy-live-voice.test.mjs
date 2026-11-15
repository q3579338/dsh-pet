/** 显式启用后验证当前国内版 WorkBuddy DeepSeek；所有声音静音，麦克风为合成信号。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'WorkBuddy native DeepSeek continues voice turns with real custom tones and recovers from synthesis failure',
  {
    skip:
      process.platform !== 'win32' ||
      process.env.DSH_PET_WORKBUDDY_LIVE !== '1' ||
      !process.env.DSH_PET_NATIVE_LIVE_ELECTRON ||
      !process.env.DSH_PET_NATIVE_COMPANION_ASAR,
  },
  async () => {
    const run = await mkdtemp(join(tmpdir(), 'codex-fish-wb-voice-'));
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
      [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/workbuddy-live-voice.cjs')],
      {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
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
          reject(Error('WorkBuddy语音后台验收超时'));
        }, 190000);
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
      assert.equal(report.offscreen, true);
      assert.equal(report.shown, false);
      assert.equal(report.nativeCalls, 0);
      assert.equal(report.live.peers, 0);
      assert.equal(report.keptMicrophoneOnFailure, true);
      assert.equal(report.bargeInStoppedOld, true);
      assert.equal(report.cancelled, true);
      assert.equal(report.memoryUntouched, true);
      assert.equal(report.workbuddyBalanceShown, true);
      assert.equal(report.codexBalanceShown, true);
      assert.equal(report.sourceAtTop, true);
      assert.equal(report.codexDictationCalls, 0);
      assert.ok(report.workbuddyAsrChildren >= 6);
      for (const voice of ['starbell-v1', 'sugarbud-v1', 'dango-v1'])
        assert.ok(report.live.metrics.some((row) => row.voice === 'bigfish-cute/' + voice && row.realSpeechEndMs > 0));
    } finally {
      if (child.exitCode === null) child.kill();
      if (env.DSH_PET_WORKBUDDY_LIVE_EVIDENCE) {
        const folder = resolve(env.DSH_PET_WORKBUDDY_LIVE_EVIDENCE);
        await mkdir(folder, { recursive: true });
        await writeFile(join(folder, 'native-live.log'), output);
        for (const file of [
          'result.json',
          'workbuddy-live-offscreen.png',
          'source-settings-offscreen.png',
          'starbell-v1.mp3',
          'sugarbud-v1.mp3',
          'dango-v1.mp3',
        ]) {
          const bytes = await readFile(join(run, file)).catch(() => null);
          if (bytes) await writeFile(join(folder, file), bytes);
        }
        const log = await readFile(join(run, 'home/dsh-pet/logs.txt')).catch(() => null);
        if (log) await writeFile(join(folder, 'isolated-pet.log'), log);
      }
      assert.ok(resolve(run).startsWith(resolve(tmpdir()) + sep));
      await rm(run, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  },
);
