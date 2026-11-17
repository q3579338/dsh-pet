/** 合成高细节4K画面，验收悬浮截图聊天；无头、静音，不读取真实桌面。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

test('悬浮截图压入请求预算并携带附件成功发送，4K细节画面不再返回413', async () => {
  const bundle = await rolldown({
    input: new URL('../../src/shared/chat/index.ts', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    platform: 'browser',
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  const menu = await readFile(new URL('../../runtime/electron-helper/sprite/menu.js', import.meta.url), 'utf8');
  const requests = [];
  const server = createServer((req, res) => {
    if (req.url === '/module.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(output[0].code);
      return;
    }
    if (req.url === '/menu.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(menu);
      return;
    }
    if (req.method === 'POST') {
      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        requests.push({ url: req.url, bytes: body.length, value: JSON.parse(body) });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html><body></body></html>');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const browser = await chromium.launch({ headless: true, args: ['--mute-audio'] });
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.evaluate(async () => {
      const module = await import('/module.js');
      window.S = { ...module, setVoiceBase() {} };
      window.BASE = location.origin + '/dsh-pet-7340';
      window.__dshPetDebug = {};
      window.PetSprite = class {};
      const canvas = document.createElement('canvas');
      canvas.width = 3840;
      canvas.height = 2160;
      const ctx = canvas.getContext('2d'),
        pixels = ctx.createImageData(canvas.width, canvas.height);
      let seed = 73;
      for (let i = 0; i < pixels.data.length; i += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        pixels.data[i] = seed & 255;
        pixels.data[i + 1] = (seed >>> 8) & 255;
        pixels.data[i + 2] = (seed >>> 16) & 255;
        pixels.data[i + 3] = 255;
      }
      ctx.putImageData(pixels, 0, 0);
      const data = canvas.toDataURL('image/jpeg', 0.85).split(',')[1];
      window.__rawBytes = atob(data).length;
      window.petBridge = {
        captureScreen: async () => ({
          mediaType: 'image/jpeg',
          data,
          width: 3840,
          height: 2160,
          bytes: window.__rawBytes,
        }),
      };
    });
    await page.addScriptTag({ url: '/menu.js' });
    const sizes = await page.evaluate(async () => {
      const sprite = new PetSprite();
      sprite.pet = { id: 'main' };
      sprite.hit = document.createElement('div');
      sprite.visibleClampRect = () => ({ x: 0, y: 0, w: 1000, h: 800 });
      sprite.syncInputBusy = () => {};
      sprite.setInteractive = () => {};
      const encoded = await sprite.captureEncoded();
      sprite.showChatFromMenu(undefined, encoded);
      const input = document.querySelector('.dsh-pet-chat-input');
      input.value = 'sssssssssss';
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return { raw: window.__rawBytes, encoded: encoded.bytes, width: encoded.width, height: encoded.height };
    });
    await page.waitForFunction(() => !document.querySelector('.dsh-pet-chat'));
    assert.ok(sizes.raw > 1024 * 1024);
    assert.ok(sizes.encoded <= 640 * 1024);
    assert.ok(Math.max(sizes.width, sizes.height) <= 2048);
    assert.equal(requests.length, 1);
    assert.ok(requests[0].bytes < 1024 * 1024);
    assert.equal(requests[0].url, '/dsh-pet-7340/chat?pet=main&surface=desktop');
    assert.equal(requests[0].value.text, 'sssssssssss');
    assert.equal(requests[0].value.attachment.mediaType, 'image/jpeg');
    assert.ok(Buffer.from(requests[0].value.attachment.data, 'base64').length <= 640 * 1024);
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
