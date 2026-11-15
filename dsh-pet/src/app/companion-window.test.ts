import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCompanionWindow, type CompanionWindow } from './companion-window.ts';

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
