/** 显式启用后验证当前国内版 WorkBuddy DeepSeek；所有声音静音，麦克风为合成信号。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'selected provider continues voice turns with real custom tones, body actions and synthesis failure recovery',
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
    if (process.env.DSH_PET_VOICE_TEST_PACK) {
      const folder = join(run, 'home/dsh-pet');
      await cp(resolve(process.env.DSH_PET_VOICE_TEST_PACK), join(folder, 'pet'), { recursive: true });
      const file = join(folder, 'pet/maixiaowen-config.json');
      const pack = JSON.parse(await readFile(file, 'utf8'));
      Object.assign(pack.pets[0], {
        display: 'desktop',
        whisperEnabled: false,
        balanceEnabled: false,
        workStatusEnabled: false,
      });
      await writeFile(file, JSON.stringify(pack));
      const mainFile = join(folder, 'main-config.jsonc');
      const main = JSON.parse(await readFile(mainFile, 'utf8'));
      main.pets[0].display = 'none';
      await writeFile(mainFile, JSON.stringify(main));
    }
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
        const timer = setTimeout(
          () => {
            child.kill();
            reject(Error('WorkBuddy语音后台验收超时'));
          },
          process.env.DSH_PET_SHOWCASE_CASES ? 250000 : 190000,
        );
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
      assert.equal(report.longTermMemoryUi, true);
      const cases = env.DSH_PET_SHOWCASE_CASES ? JSON.parse(env.DSH_PET_SHOWCASE_CASES) : [];
      assert.equal(
        report.codexDictationCalls,
        env.DSH_PET_CONVERSATION_SOURCE === 'codex' ? Math.max(1, cases.length) : 0,
      );
      if (cases.length) {
        assert.ok(report.actualSpeechTextMatches.length >= 6);
        assert.ok(new Set(report.actualSpeechTextMatches.map((row) => row.turn)).size >= 6);
        assert.ok(report.live.recognized.length >= 8);
        for (const tone of ['starbell', 'sugarbud', 'dango'])
          for (const item of cases)
            assert.ok(
              report.showcases.some(
                (row) =>
                  row.tone === tone &&
                  row.animation === item.action &&
                  row.playbackStatus === 'playing' &&
                  row.noExtraSpeech,
              ),
              tone + ' ' + item.action,
            );
      }
      if (env.DSH_PET_CONVERSATION_SOURCE === 'codex') assert.equal(report.workbuddyAsrChildren, 0);
      else assert.ok(report.workbuddyAsrChildren >= 6);
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
          'voice-bubble-action-offscreen.png',
          'workbuddy-live-offscreen.png',
          'source-settings-offscreen.png',
          'long-term-memory-offscreen.png',
          'starbell-v1.mp3',
          'sugarbud-v1.mp3',
          'dango-v1.mp3',
          'showcases.json',
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
