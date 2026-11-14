import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CodexClient } from './client.ts';
import { CodexQueue } from './events.ts';

/** 用真实管道覆盖分块、反序响应、审批拒绝和进程退出，不调用任何模型。 */
function fixture(source: string): { client: CodexClient; clean: () => Promise<void> } {
  const directory = mkdtempSync(join(tmpdir(), 'codex-pet-rpc-'));
  const script = join(directory, 'server.mjs');
  writeFileSync(
    script,
    `import readline from 'node:readline';
    const send = value => process.stdout.write(JSON.stringify(value)+'\\n');
    const lines = readline.createInterface({input:process.stdin});
    lines.on('line', line=> { const message=JSON.parse(line); ${source} });
    lines.on('close',()=>process.exit(0));`,
  );
  const client = new CodexClient(directory, process.execPath, [script]);
  return {
    client,
    async clean() {
      client.close();
      assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
      await rm(directory, { recursive: true, force: true, maxRetries: 25, retryDelay: 40 });
    },
  };
}

test('Codex handshake, split UTF-8 notifications and out-of-order requests use real stdio', async () => {
  const { client, clean } = fixture(`
    if(message.method==='initialize') send({id:message.id,result:{}});
    if(message.method==='first') setTimeout(()=>send({id:message.id,result:'first'}),20);
    if(message.method==='second') {
      send({id:message.id,result:'second'});
      const chunk=Buffer.from(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'大肥鱼'}})+'\\n');
      process.stdout.write(chunk.subarray(0,chunk.length-4));
      setTimeout(()=>process.stdout.write(chunk.subarray(chunk.length-4)),5);
    }`);
  try {
    await client.initialize();
    const notification = new Promise<string>((done) =>
      client.onNotification((event) => done(String(event.params.delta))),
    );
    const first = client.request('first', {});
    assert.equal(await client.request('second', {}), 'second');
    assert.equal(await first, 'first');
    assert.equal(await notification, '大肥鱼');
  } finally {
    await clean();
  }
});

test('Codex exit rejects pending calls and requests after close immediately', async () => {
  const { client, clean } = fixture(
    `if(message.method==='initialize') send({id:message.id,result:{}}); else if(message.id) process.exit(1);`,
  );
  try {
    await client.initialize();
    await assert.rejects(client.request('crash', {}), /连接已关闭/);
    await assert.rejects(client.request('after-close', {}), /连接已关闭/);
  } finally {
    await clean();
  }
});

test('companion never approves a server-requested command', async () => {
  const { client, clean } = fixture(
    `if(message.method==='initialize') send({id:message.id,result:{}}); else if(message.method==='approval') send({id:99,method:'item/commandExecution/requestApproval',params:{}});`,
  );
  try {
    await client.initialize();
    await assert.rejects(client.request('approval', {}), /额外操作授权/);
  } finally {
    await clean();
  }
});

test('queue preserves buffered output but cancellation discards late chunks', async () => {
  const queue = new CodexQueue<string>();
  queue.push('one');
  queue.push('two');
  queue.end();
  const output: string[] = [];
  for await (const chunk of queue.read()) output.push(chunk);
  assert.deepEqual(output, ['one', 'two']);
  const cancelled = new CodexQueue<string>();
  cancelled.push('late');
  cancelled.fail(new Error('cancelled'));
  await assert.rejects(async () => {
    for await (const chunk of cancelled.read()) output.push(chunk);
  }, /cancelled/);
  assert.equal(output.includes('late'), false);
});
