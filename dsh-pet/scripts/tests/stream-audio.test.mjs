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
  '真实 MP3 带首包缓冲抵抗抖动、未传完即可播放；取消释放，完整音频可播放',
  { skip: !process.env.DSH_PET_STREAM_SAMPLE },
  async () => {
    const sample = await readFile(process.env.DSH_PET_STREAM_SAMPLE);
    const bundle = await rolldown({
      input:
        process.env.DSH_PET_STREAM_MODULE ||
        fileURLToPath(new URL('../../src/shared/stream-audio.ts', import.meta.url)),
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
      } else if (req.url.startsWith('/jitter')) {
        const url = new URL(req.url, 'http://localhost');
        const first = Number(url.searchParams.get('first')),
          second = Number(url.searchParams.get('second'));
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        res.write(sample.subarray(0, first));
        setTimeout(() => {
          if (!res.destroyed) res.write(sample.subarray(first, second));
        }, 440);
        setTimeout(() => {
          if (!res.destroyed) res.end(sample.subarray(second));
        }, 750);
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
      const jitter = await page.evaluate(async () => {
        const bytes = await (await fetch('/complete')).arrayBuffer();
        const decoded = await new OfflineAudioContext(1, 1, 48000).decodeAudioData(bytes.slice(0));
        const first = Math.floor(bytes.byteLength * Math.min(0.24 / decoded.duration, 0.2));
        const second = Math.floor(bytes.byteLength * Math.min(0.94 / decoded.duration, 0.7));
        let waiting = 0,
          started = false,
          startDelay = 0;
        const beganAt = performance.now();
        const observer = new MutationObserver((records) => {
          for (const record of records)
            for (const node of record.addedNodes)
              if (node instanceof HTMLAudioElement)
                node.addEventListener('waiting', () => {
                  if (started) waiting++;
                });
        });
        observer.observe(document.body, { childList: true });
        await speech.playSpeechAudio(await fetch('/jitter?first=' + first + '&second=' + second), {
          signal: new AbortController().signal,
          volume: 0,
          voice: 'bigfish-cute/starbell-v1',
          started() {
            started = true;
            startDelay = performance.now() - beganAt;
          },
        });
        observer.disconnect();
        return { waiting, started, duration: decoded.duration, startDelay };
      });
      assert.equal(jitter.started, true);
      assert.equal(
        jitter.waiting,
        0,
        '240ms first packet followed by 440ms network jitter must not start and repeatedly run dry',
      );
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
