import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeechSegmenter } from './continuous-microphone.ts';

function fixture() {
  const events: string[] = [],
    chunks: Uint8Array[] = [];
  const feed = createSpeechSegmenter({
    begin: () => events.push('begin'),
    chunk: (pcm) => chunks.push(pcm),
    end: () => events.push('end'),
  });
  return {
    events,
    chunks,
    feed: (rms: number, frames = 1) => {
      for (let i = 0; i < frames; i++) feed(new Float32Array(1024).fill(rms));
    },
  };
}
test('短促点击与背景底噪不送去识别，开口后保留前256ms且不重复当前块', () => {
  const f = fixture();
  f.feed(0.005, 10);
  f.feed(0.1);
  f.feed(0, 6);
  assert.deepEqual(f.events, []);
  f.feed(0.03, 2);
  assert.deepEqual(f.events, ['begin']);
  assert.equal(f.chunks.length, 4);
  assert.equal(f.chunks[0].length, 2048);
  const pcm = new DataView(f.chunks[f.chunks.length - 1].buffer);
  assert.ok(Math.abs(pcm.getInt16(0, true) / 32767 - 0.03) < 0.001);
});
test('256ms短暂停顿不截句，320ms后恰好结束，下一句可以继续', () => {
  const f = fixture();
  f.feed(0.02, 4);
  f.feed(0, 4);
  assert.deepEqual(f.events, ['begin']);
  f.feed(0.02, 2);
  f.feed(0, 5);
  assert.deepEqual(f.events, ['begin', 'end']);
  const count = f.chunks.length;
  f.feed(0, 20);
  assert.equal(f.chunks.length, count);
  f.feed(0.04, 2);
  f.feed(0, 5);
  assert.deepEqual(f.events, ['begin', 'end', 'begin', 'end']);
});
test('长句在官方30秒上限前分段，PCM字节数量有界', () => {
  const f = fixture();
  f.feed(0.02, 438);
  assert.deepEqual(f.events, ['begin', 'end']);
  assert.ok(f.chunks.reduce((n, bytes) => n + bytes.length, 0) <= 900000);
});
