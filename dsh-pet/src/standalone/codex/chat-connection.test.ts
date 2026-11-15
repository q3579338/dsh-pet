import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { CodexClient } from './client.ts';
import { createCodexChatConnection } from './chat-connection.ts';
import { codexTextStream } from './transport.ts';
import { DEFAULT_AI_SETTINGS } from '../ai-config.ts';

test('real stdio shares completed handshake and model catalog, refreshes tool config and handles terminal errors', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'codex-fish-chat-'));
  const script = join(directory, 'server.mjs');
  writeFileSync(
    script,
    `
    import readline from 'node:readline';
    let ready=false, initialized=0, listings=0, configs=0, turns=0, failNext=false, emptyNext=false;
    const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
    const lines=readline.createInterface({input:process.stdin});
    lines.on('close',()=>process.exit(0));
    lines.on('line',line=>{
      const m=JSON.parse(line); const result=value=>send({id:m.id,result:value});
      if(m.method==='initialize'){initialized++;setTimeout(()=>{ready=true;result({});},20);return;}
      if(m.id&&!ready){send({id:m.id,error:{message:'handshake incomplete'}});return;}
      if(m.method==='model/list'){listings++;result({data:[{model:'fixture',isDefault:true,supportedReasoningEfforts:[{reasoningEffort:'low'}]}]});}
      if(m.method==='config/read'){configs++;result({config:{mcp_servers:{fixture:{enabled:true}}}});}
      if(m.method==='thread/start'){
        if(m.params.model!=='fixture'||m.params.config['mcp_servers.fixture.enabled']!==false||m.params.config['features.shell_tool']!==false)throw Error('unsafe or unavailable selection');
        result({thread:{id:'fixture-thread'}});
      }
      if(m.method==='turn/start'){
        turns++;result({});
        if(failNext){send({method:'error',params:{threadId:'fixture-thread',willRetry:false,error:{message:'usage limit reached'}}});failNext=false;return;}
        if(!emptyNext)send({method:'item/agentMessage/delta',params:{threadId:'fixture-thread',delta:'连接成功'}});
        send({method:'turn/completed',params:{threadId:'fixture-thread',turn:{status:'completed'}}});emptyNext=false;
      }
      if(m.method==='stats')result({initialized,listings,configs,turns});
      if(m.method==='invalidate'){result({});send({method:'account/updated',params:{}});}
      if(m.method==='fail-next'){failNext=true;result({});}
      if(m.method==='empty-next'){emptyNext=true;result({});}
    });
  `,
  );
  const connection = createCodexChatConnection(directory, () => new CodexClient(directory, process.execPath, [script]));
  const previousHome = process.env.DSH_HOME;
  process.env.DSH_HOME = directory;
  const collect = async (): Promise<string> => {
    let text = '';
    for await (const event of codexTextStream(
      { ...DEFAULT_AI_SETTINGS, model: 'default' },
      { system: '固定测试人设', messages: [{ role: 'user', content: '固定测试消息' }] },
      AbortSignal.timeout(3000),
      connection,
    ))
      text += event.text ?? '';
    return text;
  };
  try {
    const [first, second] = await Promise.all([connection.open(), connection.open()]);
    assert.equal(first, second);
    await Promise.all([connection.models(), connection.models()]);
    assert.equal(await collect(), '连接成功');
    assert.equal(await collect(), '连接成功');
    assert.deepEqual(await first.request('stats', {}), { initialized: 1, listings: 1, configs: 2, turns: 2 });
    const invalidated = new Promise<void>((done) => {
      const off = first.onNotification(({ method }) => {
        if (method === 'account/updated') {
          off();
          done();
        }
      });
    });
    await first.request('invalidate', {});
    await invalidated;
    await connection.models();
    assert.equal(((await first.request('stats', {})) as { listings: number }).listings, 2);
    await first.request('fail-next', {});
    await assert.rejects(collect(), /额度/);
    const fresh = await connection.open();
    assert.notEqual(fresh, first);
    await fresh.request('empty-next', {});
    await assert.rejects(collect(), /没有返回回复文字/);
    connection.dispose();
    await assert.rejects(connection.open(), /关闭/);
  } finally {
    connection.dispose();
    if (previousHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousHome;
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
    await rm(directory, { recursive: true, force: true, maxRetries: 25, retryDelay: 40 });
  }
});
