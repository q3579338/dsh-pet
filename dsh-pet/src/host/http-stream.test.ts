/** 通过真实本机 HTTP 验证首字节、断连取消与 MP3 传输背压。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { sendStream } from './http.ts';

test('HTTP 首批音频早于完成，响应不缓存；断连释放流订阅', async () => {
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let disposed = 0;
  const server = createServer((_request, response) => {
    void sendStream(response, {
      kind: 'stream',
      contentType: 'audio/mpeg',
      stream: (async function* () {
        yield new Uint8Array([1, 2]);
        await gate;
        yield new Uint8Array([3]);
      })(),
      dispose: () => {
        disposed++;
      },
    }).catch(() => {});
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  try {
    const abort = new AbortController();
    const response = await fetch(`http://127.0.0.1:${address.port}`, { signal: abort.signal });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const reader = response.body!.getReader();
    assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2]));
    assert.equal(disposed, 0);
    abort.abort();
    finish();
    for (let i = 0; i < 50 && !disposed; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(disposed, 1);
  } finally {
    finish();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
