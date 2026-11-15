/** 已打包原生窗口验收：显式启用才运行，会调用一次现有 Codex 账号；全程离屏、静音、合成麦克风。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

test(
  'native pet menu and double-click open chat; recorded Chinese reaches Codex and replies play through audio',
  {
    skip:
      process.platform !== 'win32' ||
      !process.env.DSH_PET_NATIVE_COMPANION_ELECTRON ||
      !process.env.DSH_PET_NATIVE_COMPANION_ASAR,
  },
  async () => {
    const run = await mkdtemp(join(tmpdir(), 'codex-fish-native-'));
    const root = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
    await mkdir(join(run, 'home/dsh-pet'), { recursive: true });
    await writeFile(
      join(run, 'home/dsh-pet/main-config.jsonc'),
      JSON.stringify({
        pets: [{ id: 'main', display: 'desktop', whisperEnabled: false, balanceEnabled: false }],
        trayEnabled: false,
        voiceEnabled: true,
        voiceName: 'windows/zh-CN',
        speechProvider: 'windows',
        clickSoundEnabled: false,
      }),
    );
    const env = {
      ...process.env,
      DSH_HOME: join(run, 'home'),
      DSH_PET_CODEX_OBSERVE: '0',
      DSH_PET_TASKBAR_WATCHDOG: '0',
      FISH_TEST_ROOT: root,
      FISH_TEST_RUN: run,
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      resolve(env.DSH_PET_NATIVE_COMPANION_ELECTRON),
      [join(dirname(fileURLToPath(import.meta.url)), 'fixtures/native-companion.cjs')],
      { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    try {
      await new Promise((done, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('原生离屏验收超时'));
        }, 65000);
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
      assert.equal(report.doubleClickReusesWindow, true);
      assert.match(report.transcript, /天气/);
      assert.ok(report.automaticReplyPlayback > 0);
      assert.ok(report.playback.played > 0);
      assert.equal(report.nativeQuotaRead, true);
      assert.match(report.microphoneDeniedFeedback, /麦克风未获授权/);
      assert.ok(!report.responses.some((item) => item.status === 401 || item.status === 403));
      const evidence = process.env.DSH_PET_NATIVE_COMPANION_EVIDENCE;
      if (evidence) {
        await mkdir(resolve(evidence), { recursive: true });
        await writeFile(join(resolve(evidence), 'result.json'), JSON.stringify(report, null, 2));
        await writeFile(join(resolve(evidence), 'native.log'), output);
        await writeFile(join(resolve(evidence), 'chat-offscreen.png'), await readFile(join(run, 'chat-offscreen.png')));
      }
    } finally {
      if (child.exitCode === null) child.kill();
      assert.ok(resolve(run).startsWith(resolve(tmpdir()) + sep));
      await rm(run, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  },
);
