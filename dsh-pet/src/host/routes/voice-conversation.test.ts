import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PetRouteDeps } from './types.ts';
import { handleConversationRoutes } from './voice-conversation.ts';

test('连续语音只接受指定方法和本通编号，事件流断开必须释放会话', async () => {
  const calls: unknown[] = [];
  const deps = {
    voiceConversation: {
      options: () => ({ workbuddy: true, model: 'deepseek-v4-flash' }),
      start: async (...args: unknown[]) => {
        calls.push(args);
        return { ok: true, sessionId: 'test-session', model: 'deepseek-v4-flash' };
      },
      touch: (id: string) => id === 'test-session',
      stop: (id: string) => calls.push(id),
      events: () => ({
        async *[Symbol.asyncIterator]() {
          yield new TextEncoder().encode('{"type":"ping"}\n');
        },
      }),
      audio: async (...args: unknown[]) => calls.push(args),
      end: (...args: unknown[]) => calls.push(args),
    },
  } as unknown as PetRouteDeps;
  const route = (action: string, method: string, body?: string) =>
    handleConversationRoutes(deps, {
      url: new URL('http://localhost/dsh-pet-7340/voice/conversation/' + action),
      rest: 'voice/conversation/' + action.split('?')[0],
      method,
      body,
    });
  assert.equal((await route('options', 'POST'))?.kind, 'json');
  const badJson = await route('start', 'POST', '{');
  assert.ok(badJson?.kind === 'json' && badJson.status === 400);
  const start = await route('start', 'POST', '{"petId":"fish","styleId":"starbell"}');
  assert.ok(start?.kind === 'json' && (start.obj as { ok: boolean }).ok);
  const unknown = await route('events?sessionId=other', 'GET');
  assert.ok(unknown?.kind === 'json' && !(unknown.obj as { ok: boolean }).ok);
  const events = await route('events?sessionId=test-session', 'GET');
  assert.equal(events?.kind, 'stream');
  if (events?.kind === 'stream') {
    assert.equal(events.contentType, 'application/x-ndjson');
    events.dispose();
  }
  assert.ok(calls.includes('test-session'));
  await route('audio', 'POST', '{"sessionId":"test-session","utterance":1,"sequence":0,"audio":"AAECAw=="}');
  assert.deepEqual(calls[calls.length - 1], ['test-session', 1, 0, 'AAECAw==']);
  for (const body of ['null', '[]', '{}', '{"sessionId":"../private"}']) {
    const result = await route('audio', 'POST', body);
    assert.ok(result?.kind === 'json' && !(result.obj as { ok: boolean }).ok);
  }
});
