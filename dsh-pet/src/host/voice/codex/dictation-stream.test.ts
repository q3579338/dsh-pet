import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { WebSocket } from 'undici';
import { createStreamingDictation } from './dictation-stream.ts';

class Socket extends EventTarget {
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
  }
  message(value: unknown) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(value) }));
  }
}
async function open() {
  const socket = new Socket(),
    partial: string[] = [],
    abort = new AbortController();
  const pending = createStreamingDictation((text) => partial.push(text), abort.signal, {
    identity: async () => ({ token: 'only-for-fixed-backend' }),
    connect: () => {
      queueMicrotask(() => {
        socket.dispatchEvent(new Event('open'));
        socket.message({ type: 'session.started' });
      });
      return socket as unknown as WebSocket;
    },
  });
  return { socket, partial, abort, stream: await pending };
}
test('音频边说边发送；最终确认结束才交回文字，不把部分文字当最终输入', async () => {
  const f = await open();
  assert.equal(f.socket.sent[0].type, 'session.start');
  assert.equal(JSON.stringify(f.socket.sent).includes('only-for-fixed-backend'), false);
  f.stream.append(new Uint8Array([0, 1, 2, 3]));
  assert.deepEqual(f.socket.sent[1], { type: 'audio.append', audio: 'AAECAw==' });
  f.socket.message({ type: 'transcript.segment', text: '我想养' });
  assert.deepEqual(f.partial, ['我想养']);
  const result = f.stream.finish();
  assert.equal(f.socket.sent[f.socket.sent.length - 1]?.type, 'session.close');
  f.socket.message({ type: 'transcript.final', text: ' 我想养大肥鱼。 ' });
  assert.equal(await result, '我想养大肥鱼。');
  assert.equal(f.socket.closed, true);
});
test('取消和上游错误立即结束，任意错误正文不能泄露给页面', async () => {
  for (const cancel of [false, true]) {
    const f = await open();
    const result = f.stream.finish();
    if (cancel) f.abort.abort();
    else f.socket.message({ type: 'session.error', fatal: true, error: { message: 'secret-private-token' } });
    await assert.rejects(result, (error) => error instanceof Error && !error.message.includes('secret'));
    assert.equal(f.socket.closed, true);
  }
});
test('奇数PCM、过大音频、网络积压和30秒越界均不能继续发送', async () => {
  const f = await open();
  try {
    assert.throws(() => f.stream.append(new Uint8Array(3)));
    assert.throws(() => f.stream.append(new Uint8Array(40000)));
    for (let i = 0; i < 29; i++) f.stream.append(new Uint8Array(32000));
    f.stream.append(new Uint8Array(32000));
    assert.throws(() => f.stream.append(new Uint8Array(2)));
  } finally {
    f.stream.dispose();
  }
  const blocked = await open();
  blocked.socket.bufferedAmount = 128001;
  assert.throws(() => blocked.stream.append(new Uint8Array(2)));
  assert.equal(blocked.socket.closed, true);
});
test('连接中取消同样关闭，不留下等待识别或认证的连接', async () => {
  const socket = new Socket(),
    abort = new AbortController();
  const pending = createStreamingDictation(() => {}, abort.signal, {
    identity: async () => ({ token: 'test' }),
    connect: () => {
      queueMicrotask(() => abort.abort());
      return socket as unknown as WebSocket;
    },
  });
  await assert.rejects(pending);
  assert.equal(socket.closed, true);
});
