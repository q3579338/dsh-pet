/**
 * 已打包入口的无窗口回归：防止 ESM 顶层 await 与 Electron ready 再次互等。
 * 显式指定程序才运行；配置、Chromium 目录独立，异常回落也不显示宠物或托盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

test(
  'packaged DPI probe returns promptly without starting the desktop service',
  {
    skip: process.platform !== 'win32' || !process.env.DSH_PET_DPI_APP,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-fish-dpi-'));
    await mkdir(join(root, 'dsh-pet'));
    await writeFile(
      join(root, 'dsh-pet/main-config.jsonc'),
      JSON.stringify({
        trayEnabled: false,
        voiceEnabled: false,
        clickSoundEnabled: false,
        pets: [{ id: 'main', display: 'none', whisperEnabled: false, balanceEnabled: false }],
      }),
    );
    const env = {
      ...process.env,
      DSH_HOME: root,
      DSH_PET_DPI_PROBE: '1',
      DSH_PET_SMOKE: '0',
      DSH_PET_CODEX_OBSERVE: '0',
    };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(
      resolve(process.env.DSH_PET_DPI_APP),
      ['--mute-audio', '--user-data-dir=' + join(root, 'electron')],
      {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += String(chunk).slice(0, 16384);
    });
    child.stderr.resume();
    try {
      const result = await new Promise((done, reject) => {
        const timeout = setTimeout(() => {
          child.kill();
          reject(new Error('DPI probe exceeded five seconds'));
        }, 5000);
        child.once('error', (error) => {
          clearTimeout(timeout);
          reject(error);
        });
        child.once('exit', (code) => {
          clearTimeout(timeout);
          done(code);
        });
      });
      assert.equal(result, 0);
      const scale = output.match(/dsh-pet-primary-scale:([0-9.]+)/)?.[1];
      assert.ok(Number(scale) > 0, '必须返回真实缩放，而不是启动另一个桌宠');
      await assert.rejects(access(join(root, 'dsh-pet/standalone-runtime.json')));
    } finally {
      if (child.exitCode === null) child.kill();
      assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
      await rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
    }
  },
);
