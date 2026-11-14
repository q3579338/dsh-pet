import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rolloutEvent, startCodexMonitor } from './monitor.ts';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodexSessionEvent } from './events.ts';

/** 有界等待真实轮询读盘，不依赖测试进程的调度速度。 */
async function until(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Codex 状态文件未被及时读取');
    await new Promise((done) => setTimeout(done, 25));
  }
}

test('only actual task completion is success; assistant messages and item completion are not', () => {
  assert.equal(
    rolloutEvent({ type: 'event_msg', payload: { type: 'task_complete' } })?.data?.reason !== undefined,
    true,
  );
  for (const type of ['agent_message', 'item_completed', 'token_count'])
    assert.equal(rolloutEvent({ type: 'event_msg', payload: { type } }), undefined);
  assert.equal(
    rolloutEvent({ type: 'response_item', payload: { type: 'message', content: 'private reply' } }),
    undefined,
  );
  assert.deepEqual(rolloutEvent({ type: 'event_msg', payload: { type: 'turn_aborted' } }), {
    type: 'turn/end',
    data: { reason: { kind: 'aborted' } },
  });
});

test('native activity is reduced without exposing command arguments, output or chat text', () => {
  const call = rolloutEvent({
    type: 'response_item',
    payload: { type: 'function_call', name: 'exec', call_id: 'call-1', arguments: 'PRIVATE_SECRET' },
  });
  assert.equal(call?.type, 'tool/call');
  assert.equal(JSON.stringify(call).includes('PRIVATE_SECRET'), false);
  assert.equal(
    rolloutEvent({ type: 'response_item', payload: { type: 'function_call', name: 'request_user_input' } })?.type,
    'approval/asked',
  );
  assert.equal(
    rolloutEvent({
      type: 'response_item',
      payload: { type: 'custom_tool_call_output', call_id: 'call-1', output: 'PRIVATE_SECRET' },
    })?.type,
    'tool/result',
  );
});

test('native log tail follows appended turns, ignores old completion and stops on dispose', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-fish-monitor-'));
  const date = new Date();
  const directory = join(
    root,
    'sessions',
    String(date.getUTCFullYear()),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0'),
  );
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'rollout-00000000-0000-0000-0000-000000000001.jsonl');
  const line = (type: string): string =>
    JSON.stringify({ type: 'event_msg', payload: { type, text: 'PRIVATE_SECRET' } }) + '\n';
  await writeFile(path, line('task_complete'));
  const events: CodexSessionEvent[] = [];
  const dispose = startCodexMonitor((event) => events.push(event), root);
  try {
    await new Promise((done) => setTimeout(done, 250));
    assert.equal(events.length, 0, '启动时不能重放旧的完成状态');
    await appendFile(path, line('task_started'));
    await until(() => events.length === 1);
    assert.equal(events[0].event.type, 'turn/start');
    const complete = line('task_complete');
    await appendFile(path, complete.slice(0, -1));
    await new Promise((done) => setTimeout(done, 2100));
    assert.equal(events.length, 1, '部分 JSON 行不能误判成完成');
    await appendFile(path, '\n');
    await until(() => events.length === 2);
    assert.deepEqual(events[1].event.data, { reason: { kind: 'completed' } });
    assert.equal(JSON.stringify(events).includes('PRIVATE_SECRET'), false);
    dispose();
    await appendFile(path, line('task_started'));
    await new Promise((done) => setTimeout(done, 2100));
    assert.equal(events.length, 2);
  } finally {
    dispose();
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
