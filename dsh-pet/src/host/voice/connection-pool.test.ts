/** 连接复用不改声音或文本，并隔离旧轮帧、取消、断连和迟到的准备请求。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSpeechConnectionPool, type SpeechSocket } from './connection-pool.ts';

class FakeSocket implements SpeechSocket {
  binaryType = '';
  readyState = 1;
  onopen: SpeechSocket['onopen'] = null;
  onmessage: SpeechSocket['onmessage'] = null;
  onerror: SpeechSocket['onerror'] = null;
  onclose: SpeechSocket['onclose'] = null;
  sent: string[] = [];
  closed = 0;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed++;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({ code: 1000 }));
  }
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }
}
/** 让虚拟本段关闭事件与异步准备落地。 */
async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('一个已准备的连接顺序传输两个实际 SSML，本段结束不物理断连，旧文本与二进制帧被隔离', async () => {
  const raw = new FakeSocket();
  let connects = 0;
  const pool = createSpeechConnectionPool({
    connect: async () => {
      connects++;
      return raw;
    },
  });
  await pool.prepare('call', true);
  const fallback = (): SpeechSocket => {
    assert.fail('Should reuse warm connection');
  };
  const first = pool.take(fallback);
  let opened = 0,
    ended = 0;
  first.onopen = () => opened++;
  first.onclose = () => ended++;
  first.onmessage = () => first.close();
  first.send('X-RequestId:a\r\nPath:ssml\r\n\r\n星铃 +18Hz');
  await tick();
  raw.receive('X-RequestId:a\r\nPath:turn.end\r\n\r\n');
  await tick();
  assert.equal(opened, 1);
  assert.equal(ended, 1);
  assert.equal(raw.closed, 0);
  const second = pool.take(fallback);
  let received = 0;
  second.onmessage = () => received++;
  second.send('X-RequestId:b\r\nPath:ssml\r\n\r\n团子 +48Hz');
  raw.receive('X-RequestId:a\r\nPath:turn.end\r\n\r\n');
  const oldHead = new TextEncoder().encode('X-RequestId:a\r\nPath:audio\r\n');
  const oldFrame = new Uint8Array(2 + oldHead.length + 3);
  oldFrame[0] = oldHead.length >> 8;
  oldFrame[1] = oldHead.length & 255;
  oldFrame.set(oldHead, 2);
  raw.receive(oldFrame.buffer);
  assert.equal(received, 0);
  raw.receive('X-RequestId:b\r\nPath:turn.end\r\n\r\n');
  second.close();
  await tick();
  assert.equal(received, 1);
  assert.equal(connects, 1);
  assert.deepEqual(raw.sent, [
    'X-RequestId:a\r\nPath:ssml\r\n\r\n星铃 +18Hz',
    'X-RequestId:b\r\nPath:ssml\r\n\r\n团子 +48Hz',
  ]);
  await pool.prepare('call', false);
  assert.equal(raw.closed, 1);
});

test('未完成一段就取消必须关闭物理连接；重开连接后取消旧所有者不影响新通话', async () => {
  const raw: FakeSocket[] = [];
  const pool = createSpeechConnectionPool({
    connect: async () => {
      const socket = new FakeSocket();
      raw.push(socket);
      return socket;
    },
  });
  await pool.prepare('old', true);
  const first = pool.take(() => new FakeSocket());
  let closed = 0;
  first.onclose = () => closed++;
  first.close();
  await tick();
  assert.equal(raw[0].closed, 1);
  assert.equal(closed, 1);
  await pool.prepare('new', true);
  await pool.prepare('old', false);
  assert.equal(raw[1].closed, 0);
  assert.equal(await pool.prepare('old', true), false);
  await pool.prepare('new', false);
  assert.equal(raw[1].closed, 1);
});

test('结束发生在连接尚未创建完之前，迟到连接不保留，不重新上传或生成台词', async () => {
  const raw = new FakeSocket();
  let ready!: (socket: SpeechSocket) => void;
  const pool = createSpeechConnectionPool({
    connect: () =>
      new Promise((resolve) => {
        ready = resolve;
      }),
  });
  const pending = pool.prepare('call', true);
  await pool.prepare('call', false);
  ready(raw);
  assert.equal(await pending, false);
  assert.equal(raw.closed, 1);
  assert.deepEqual(raw.sent, []);
});

test('连接被占用时独立请求走原来的连接，不混入当前 SSML；网络错误不会留下可复用的连接', async () => {
  const raw = new FakeSocket(),
    fallback = new FakeSocket();
  const pool = createSpeechConnectionPool({ connect: async () => raw });
  await pool.prepare('call', true);
  const first = pool.take(() => fallback);
  assert.notEqual(first, fallback);
  assert.equal(
    pool.take(() => fallback),
    fallback,
  );
  let failed = 0;
  first.onerror = () => failed++;
  raw.onerror?.({ error: new Error('closed') });
  assert.equal(failed, 1);
  assert.equal(raw.closed, 1);
  assert.equal(
    pool.take(() => fallback),
    fallback,
  );
  await pool.prepare('call', false);
});

test('无持续请求的准备连接会自动到期关闭', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const raw = new FakeSocket();
  const pool = createSpeechConnectionPool({ connect: async () => raw, idleMs: 18000 });
  await pool.prepare('call', true);
  t.mock.timers.tick(18000);
  assert.equal(raw.closed, 1);
  await pool.prepare('call', false);
});

test('开口打断关闭旧连接后自动补回准备；结束通话会取消补回，不在后台无限重连', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const sockets: FakeSocket[] = [];
  const pool = createSpeechConnectionPool({
    connect: async () => {
      const raw = new FakeSocket();
      sockets.push(raw);
      return raw;
    },
  });
  await pool.prepare('call', true);
  pool.take(() => assert.fail()).close();
  t.mock.timers.tick(80);
  await tick();
  assert.equal(sockets.length, 2);
  const next = pool.take(() => assert.fail('New utterance must find a prepared connection'));
  next.close();
  await pool.prepare('call', false);
  t.mock.timers.tick(20000);
  await tick();
  assert.equal(sockets.length, 2);
  assert.ok(sockets.every((raw) => raw.closed > 0));
});
