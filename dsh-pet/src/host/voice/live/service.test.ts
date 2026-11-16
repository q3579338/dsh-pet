/** 即时语音的所有权与错误边界：只结束自己那通，不写普通聊天记忆，不泄露登录。 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { CodexNotification } from '../../../standalone/codex/client.ts';
import { createLiveVoiceService } from './service.ts';
import { createCodexLiveCall } from './http.ts';

/** 用受控客户端替换进程与网络，保留真实会话配置和结束流程。 */
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'codex-voice-unit-'));
  const changes: boolean[] = [];
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let closed = 0;
  let notify: ((value: CodexNotification) => void) | undefined;
  let onClose: ((error: Error) => void) | undefined;
  const client = {
    initialize: async () => {},
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      if (method === 'config/read') return { config: { mcp_servers: { example: {} } } };
      if (method === 'model/list')
        return { data: [{ model: 'gpt-6-luna', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
      if (method === 'thread/start') return { thread: { id: 'test-thread' } };
      if (method === 'thread/realtime/listVoices') return { voices: { v3: ['breeze', 'maple'] } };
      return {};
    },
    onNotification: (listener: (value: CodexNotification) => void) => {
      notify = listener;
      return () => {
        notify = undefined;
      };
    },
    onClose: (listener: (error: Error) => void) => {
      onClose = listener;
      return () => {
        onClose = undefined;
      };
    },
    close: () => {
      closed++;
      onClose?.(new Error('test connection closed'));
    },
  };
  const deps = {
    home,
    settings: (id: string) => (id === 'main' ? { prompt: '你是大肥鱼。', model: 'gpt-6-luna' } : undefined),
    activeChanged: (active: boolean) => changes.push(active),
    createClient: () => client,
    identity: async () => ({ token: 'test-only-token' }),
    createCall: async (input: Parameters<typeof createCodexLiveCall>[0]) => {
      void input;
      return { answerSdp: 'v=0\r\nanswer', callId: 'test-call' };
    },
  };
  const service = createLiveVoiceService(deps);
  return {
    service,
    deps,
    requests,
    changes,
    closed: () => closed,
    notify: (method: string, params: Record<string, unknown> = {}) =>
      notify?.({ method, params: { threadId: 'test-thread', ...params } }),
    cleanup: () => {
      service.dispose();
      assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test('原生通话载入长期信息，仅最终用户字幕可写入；管理后结束旧通话，允许重新连接', async () => {
  const f = fixture(),
    remembered: string[] = [];
  let usedPrompt = '';
  f.deps.createCall = async (input) => {
    usedPrompt = input.prompt;
    return { answerSdp: 'v=0\r\nanswer', callId: 'test-call' };
  };
  Object.assign(f.deps, {
    memory: {
      context: () => '\n用户希望被称为「星宝」',
      remember: (_id: string, text: string) => {
        remembered.push(text);
        return 1;
      },
    },
  });
  try {
    assert.equal((await f.service.start('main', 'v=0\r\ntest')).ok, true);
    assert.match(usedPrompt, /星宝/u);
    f.notify('thread/realtime/transcript/done', { role: 'assistant', text: '模型虚构的事实' });
    f.notify('thread/realtime/transcript/done', { role: 'user', text: '不该记录', threadId: 'other' });
    f.notify('thread/realtime/transcript/done', { role: 'user', text: '我喜欢' });
    f.notify('thread/realtime/transcript/done', { role: 'user', text: '喝咖啡' });
    f.notify('thread/realtime/transcript/delta', { role: 'assistant', text: '收到' });
    assert.deepEqual(remembered, ['我喜欢喝咖啡']);
    f.notify('thread/realtime/transcript/done', { role: 'user', text: '这段应随停止一起丢弃' });
    f.service.stopAll();
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(remembered, ['我喜欢喝咖啡']);
    assert.ok(f.closed() > 0);
    assert.equal((await f.service.start('main', 'v=0\r\ntest')).ok, true);
    f.notify('thread/realtime/transcript/done', { role: 'user', text: '我喜欢' });
    f.notify('thread/realtime/transcript/done', { role: 'user', text: '茶' });
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.deepEqual(remembered, ['我喜欢喝咖啡', '我喜欢茶']);
  } finally {
    f.cleanup();
  }
});

test('Codex画面只受理当前有效通话，提示包含动画能力；停止与切换来源拒绝迟到更新', async () => {
  const f = fixture(),
    frames: unknown[] = [];
  let source = 'codex',
    disposed = 0,
    prompt = '';
  Object.assign(f.deps, {
    source: () => source,
    presentation: () => ({
      instructions: () => '可表演吃西瓜',
      accept: (frame: unknown) => {
        frames.push(frame);
        return true;
      },
      dispose: () => {
        disposed++;
      },
    }),
  });
  f.deps.createCall = async (input) => {
    prompt = input.prompt;
    return { answerSdp: 'v=0\r\nanswer', callId: 'test-call' };
  };
  try {
    const call = await f.service.start('main', 'v=0');
    assert.equal(call.ok, true);
    if (!call.ok) return;
    assert.match(prompt, /吃西瓜/u);
    assert.equal(f.service.present('other', {}), false);
    assert.equal(f.service.present(call.sessionId, { type: 'user' }), true);
    source = 'workbuddy';
    assert.equal(f.service.present(call.sessionId, {}), false);
    source = 'codex';
    await f.service.stop(call.sessionId);
    assert.equal(f.service.present(call.sessionId, {}), false);
    assert.equal(frames.length, 1);
    assert.equal(disposed, 1);
  } finally {
    f.cleanup();
  }
});

test('临时只读会话只接 existingCall，错误编号不能结束或续租；停止幂等', async () => {
  const f = fixture();
  try {
    const result = await f.service.start('main', 'v=0\r\noffer');
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const thread = f.requests.find((value) => value.method === 'thread/start')!.params;
    assert.equal(thread.ephemeral, true);
    assert.equal(thread.sandbox, 'read-only');
    assert.equal(thread.approvalPolicy, 'never');
    assert.equal((thread.config as Record<string, unknown>)['mcp_servers.example.enabled'], false);
    assert.equal((thread.config as Record<string, unknown>)['features.shell_tool'], false);
    const realtime = f.requests.find((value) => value.method === 'thread/realtime/start')!.params;
    assert.deepEqual(realtime.transport, { type: 'existingCall', callId: 'test-call' });
    assert.equal(realtime.voice, undefined, '音色在 WebRTC 创建时设置，existingCall 不重新覆盖');
    assert.equal(realtime.includeStartupContext, false);
    assert.equal(f.service.touch('wrong'), false);
    await f.service.stop('wrong');
    assert.equal(f.closed(), 0);
    assert.equal(f.service.touch(result.sessionId), true);
    await f.service.stop(result.sessionId);
    await f.service.stop(result.sessionId);
    assert.equal(f.closed(), 1);
    assert.equal(f.service.touch(result.sessionId), false);
    assert.deepEqual(f.changes, [true, false]);
    assert.equal(f.requests.filter((value) => value.method === 'thread/realtime/stop').length, 1);
  } finally {
    f.cleanup();
  }
});

test('并发打开不会覆盖已有连接；取消连接与远端关闭都会归还占用', async () => {
  const f = fixture();
  try {
    const controller = new AbortController();
    const first = f.service.start('main', 'v=0', controller.signal);
    assert.equal((await f.service.start('main', 'v=0')).ok, false);
    controller.abort();
    assert.equal((await first).ok, false);
    assert.equal(f.changes[f.changes.length - 1], false);
    const next = await f.service.start('main', 'v=0');
    assert.equal(next.ok, true);
    f.notify('thread/realtime/closed');
    assert.equal(f.changes[f.changes.length - 1], false);
    if (next.ok) assert.equal(f.service.touch(next.sessionId), false);
  } finally {
    f.cleanup();
  }
});

test('未知宠物和无效协商不启动连接；异常正文和凭据不返回页面', async () => {
  const f = fixture();
  try {
    assert.equal((await f.service.start('unknown', 'v=0')).ok, false);
    assert.equal((await f.service.start('main', 'invalid')).ok, false);
    assert.equal(f.requests.length, 0);
    assert.equal((await f.service.start('main', 'v=0', undefined, 'unknown')).ok, false);
    assert.equal(f.requests.length, 0);
    const failing = createLiveVoiceService({
      ...f.deps,
      createCall: async () => {
        throw Error('Bearer test-only-secret');
      },
    });
    const result = await failing.start('main', 'v=0');
    assert.equal(result.ok, false);
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(f.changes[f.changes.length - 1], false);
    failing.dispose();
  } finally {
    f.cleanup();
  }
});

test('协商只请求固定官方地址；账号凭据仅在请求头，失败正文不会回显', async () => {
  const input = {
    sdp: 'v=0',
    threadId: 'test-thread',
    sessionId: 'test-session',
    prompt: '大肥鱼',
    model: 'gpt-6-luna',
    effort: 'low',
    identity: { token: 'test-only-token', accountId: 'test-account' },
    signal: new AbortController().signal,
  };
  const result = await createCodexLiveCall(input, async (url, init) => {
    assert.equal(
      String(url),
      'https://chatgpt.com/backend-api/wham/realtime/calls?intent=quicksilver&architecture=avas',
    );
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer test-only-token');
    assert.ok(!String(init?.body).includes('test-only-token'));
    assert.equal(JSON.parse(String(init?.body)).session.model, 'gpt-live-1.1-codex');
    assert.equal(JSON.parse(String(init?.body)).session.audio, undefined);
    assert.deepEqual(JSON.parse(String(init?.body)).session.initial_items, [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: input.prompt }] },
    ]);
    return new Response('v=0\r\nanswer', { status: 201, headers: { location: '/calls/test-call' } });
  });
  assert.equal(result.callId, 'test-call');
  for (const status of [401, 403, 429, 500])
    await assert.rejects(
      createCodexLiveCall(input, async () => new Response('Bearer test-only-secret', { status })),
      (error) => error instanceof Error && !error.message.includes('secret'),
    );
});
