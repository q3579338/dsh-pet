/** 本机真实 MP3 解码，强制无头与静音；外部音色样本通过显式环境变量传入。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { rolldown } from 'rolldown';

test(
  '真实 MP3 尚未传完就开始播放；取消立即释放流播放器，完整音频仍可播放',
  { skip: !process.env.DSH_PET_STREAM_SAMPLE },
  async () => {
    const sample = await readFile(process.env.DSH_PET_STREAM_SAMPLE);
    const bundle = await rolldown({
      input: fileURLToPath(new URL('../../src/shared/stream-audio.ts', import.meta.url)),
      platform: 'browser',
    });
    const { output } = await bundle.generate({ format: 'esm' });
    await bundle.close();
    let release;
    let completed = false;
    const server = createServer((req, res) => {
      if (req.url === '/module.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        res.end(output[0].code);
      } else if (req.url === '/complete') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.end(sample);
      } else if (req.url === '/audio') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        const middle = Math.floor(sample.length * 0.7);
        res.write(sample.subarray(0, middle));
        release = () => {
          completed = true;
          res.end(sample.subarray(middle));
        };
      } else {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<script type="module">import * as speech from "/module.js"; window.speech=speech;</script>');
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const browser = await chromium.launch({
      headless: true,
      args: ['--mute-audio', '--autoplay-policy=no-user-gesture-required'],
    });
    try {
      const page = await browser.newPage();
      await page.goto('http://127.0.0.1:' + server.address().port);
      await page.waitForFunction(() => !!window.speech);
      assert.equal(await page.evaluate(() => speech.canStreamSpeech()), true);
      await page.evaluate(async () => {
        window.started = 0;
        window.done = false;
        window.controller = new AbortController();
        const response = await fetch('/audio', { signal: controller.signal });
        window.playing = speech
          .playSpeechAudio(response, {
            signal: controller.signal,
            volume: 0,
            voice: 'bigfish-cute/starbell-v1',
            started() {
              window.started++;
            },
          })
          .then(
            () => {
              window.done = true;
            },
            () => {
              window.cancelled = true;
            },
          );
      });
      await page.waitForFunction(() => window.started === 1);
      assert.equal(completed, false, '真实 playing 事件必须早于服务端结束');
      assert.equal(await page.evaluate(() => window.done), false);
      release();
      await page.waitForFunction(() => window.done);
      assert.equal(await page.locator('audio').count(), 0);
      completed = false;
      await page.evaluate(async () => {
        window.started = 0;
        window.controller = new AbortController();
        const response = await fetch('/audio', { signal: controller.signal });
        window.playing = speech
          .playSpeechAudio(response, {
            signal: controller.signal,
            volume: 0,
            voice: 'bigfish-cute/dango-v1',
            started() {
              window.started++;
            },
          })
          .catch(() => {
            window.cancelled = true;
          });
      });
      await page.waitForFunction(() => window.started === 1);
      await page.evaluate(async () => {
        controller.abort();
        await window.playing;
      });
      assert.equal(await page.locator('audio').count(), 0);
      assert.equal(await page.evaluate(() => window.cancelled), true);
      release();
      await page.evaluate(async () => {
        window.started = 0;
        const blob = await (await fetch('/complete')).blob();
        await speech.playSpeechAudio(blob, {
          signal: new AbortController().signal,
          volume: 0,
          voice: 'bigfish-cute/sugarbud-v1',
          started() {
            window.started++;
          },
        });
      });
      assert.equal(await page.evaluate(() => window.started), 1);
      assert.equal(await page.locator('audio').count(), 0);
    } finally {
      release?.();
      await browser.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  },
);
