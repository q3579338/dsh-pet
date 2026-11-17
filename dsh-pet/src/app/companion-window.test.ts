import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionWindow, type CompanionWindow } from './companion-window.ts';

test('unsaved settings show a close decision; cancel stays open and discard permits unloading', () => {
  let unload: ((event: { preventDefault(): void }) => void) | undefined;
  let discard = false;
  let confirmations = 0;
  const companion = createCompanionWindow({
    settingsUrl: 'http://127.0.0.1:1234/standalone-ai/',
    log: () => {},
    confirmDiscard: () => {
      confirmations++;
      return discard;
    },
    create: () => ({
      isDestroyed: () => false,
      showInactive() {},
      focus() {},
      once() {},
      loadURL: async () => {},
      webContents: {
        on: (_event, callback) => {
          unload = callback;
        },
      },
    }),
  });
  companion.open();
  let allowed = 0;
  unload?.({
    preventDefault: () => {
      allowed++;
    },
  });
  assert.equal(allowed, 0);
  discard = true;
  unload?.({
    preventDefault: () => {
      allowed++;
    },
  });
  assert.equal(allowed, 1);
  assert.equal(confirmations, 2);
});

test('native chat opens on request, reuses its draft and recreates only after closing', async () => {
  const created: Array<{ options: Record<string, unknown>; urls: string[]; ready: () => void; close: () => void }> = [];
  let focused = 0;
  const companion = createCompanionWindow({
    settingsUrl: 'http://127.0.0.1:1234/standalone-ai/#token=private',
    log: () => {},
    create: (options) => {
      let destroyed = false;
      const record = { options, urls: [] as string[], ready: () => {}, close: () => {} };
      const window: CompanionWindow = {
        isDestroyed: () => destroyed,
        showInactive: () => {},
        focus: () => {
          focused++;
        },
        async loadURL(url) {
          record.urls.push(url);
        },
        once(event, callback) {
          if (event === 'ready-to-show') record.ready = callback;
          else
            record.close = () => {
              destroyed = true;
              callback();
            };
        },
      };
      created.push(record);
      return window;
    },
  });
  assert.equal(created.length, 0);
  companion.open('chat', false);
  assert.equal(created[0].options.show, false);
  created[0].ready();
  await Promise.resolve();
  assert.equal(focused, 0);
  assert.equal(new URL(created[0].urls[0]).searchParams.get('view'), 'chat');
  companion.open();
  assert.equal(created.length, 1);
  assert.equal(created[0].urls.length, 1);
  assert.ok(focused > 0);
  companion.open('config');
  assert.equal(created.length, 1);
  assert.equal(new URL(created[0].urls[1]).searchParams.get('view'), 'config');
  created[0].close();
  companion.open();
  assert.equal(created.length, 2);
});

test('打开指定宠物用自己的查询参数，已打开窗口用事件切换而不刷新草稿', async () => {
  const urls: string[] = [],
    scripts: string[] = [];
  const companion = createCompanionWindow({
    settingsUrl: 'http://127.0.0.1:1234/',
    log() {},
    create: () => ({
      isDestroyed: () => false,
      showInactive() {},
      focus() {},
      once() {},
      async loadURL(url) {
        urls.push(url);
      },
      webContents: {
        on() {},
        async executeJavaScript(script) {
          scripts.push(script);
        },
      },
    }),
  });
  companion.open('chat', false, 'mai');
  await Promise.resolve();
  assert.equal(new URL(urls[0]).searchParams.get('pet'), 'mai');
  companion.open('chat', false, 'main');
  await Promise.resolve();
  assert.equal(urls.length, 1);
  assert.match(scripts[0], /pet-chat-target/);
  assert.match(scripts[0], /main/);
});
