import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startDesktopEntry, revealExistingWindows, type StartupApp } from './startup.ts';

/** 用已被旧实例持有的锁验证探测旁路，避免再次出现父子互等。 */
test('DPI child completes while another app holds the single-instance lock and never boots the pet', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-fish-startup-'));
  let profile = '';
  let ready = false;
  let flushed = false;
  const exits: number[] = [];
  const app: StartupApp = {
    setName() {},
    getPath: () => assert.fail('DPI 子进程不使用普通窗口配置'),
    setPath: (_name, path) => {
      profile = path;
    },
    commandLine: { getSwitchValue: () => '' },
    disableHardwareAcceleration() {},
    whenReady: async () => {
      ready = true;
    },
    requestSingleInstanceLock: () => assert.fail('旧实例持锁时探测不能申请同一把锁'),
    exit: (code = 0) => {
      assert.equal(flushed, true);
      exits.push(code);
    },
  };
  try {
    await startDesktopEntry({
      app,
      home: root,
      probe: true,
      screen: {
        getPrimaryDisplay: () => {
          assert.equal(ready, true);
          return { scaleFactor: 1.25 };
        },
      },
      boot: async () => assert.fail('探测不能启动服务或宠物'),
      writeProbe: async (line) => {
        assert.equal(line, 'dsh-pet-primary-scale:1.25\n');
        await Promise.resolve();
        flushed = true;
      },
    });
    assert.equal(profile, join(root, 'dpi-profile'));
    assert.deepEqual(exits, [0]);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('normal startup honors an explicit profile and does not boot a duplicate instance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-fish-profile-'));
  const custom = join(root, 'custom');
  let profile = '';
  let booted = 0;
  let locked = false;
  let exits = 0;
  const app: StartupApp = {
    setName() {},
    getPath: () => root,
    setPath: (_name, path) => {
      profile = path;
    },
    commandLine: { getSwitchValue: () => custom },
    disableHardwareAcceleration() {},
    whenReady: async () => {},
    requestSingleInstanceLock: () => locked,
    exit: () => {
      exits++;
    },
  };
  try {
    const options = {
      app,
      home: root,
      probe: false,
      screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
      boot: async () => {
        booted++;
      },
    };
    await startDesktopEntry(options);
    assert.equal(profile, custom);
    assert.equal(booted, 0);
    assert.equal(exits, 1);
    locked = true;
    await startDesktopEntry(options);
    assert.equal(booted, 1);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('reopening an existing pet shows live windows without requesting keyboard focus', () => {
  let shown = 0;
  const live = {
    isDestroyed: () => false,
    showInactive: () => {
      shown++;
    },
    focus: () => assert.fail('不能抢焦点'),
  };
  const destroyed = { ...live, isDestroyed: () => true, showInactive: () => assert.fail('不能显示已销毁窗口') };
  revealExistingWindows([live, destroyed]);
  assert.equal(shown, 1);
});
