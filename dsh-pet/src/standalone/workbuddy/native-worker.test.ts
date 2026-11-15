import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const worker = createRequire(import.meta.url)('../../../runtime/workbuddy-native.cjs') as {
  inputRequest(value: unknown): unknown;
  catalogModels(value: unknown): Array<{ id: string; name: string }>;
  chatFrames(): { accept(line: string): unknown[]; finish(): void };
  runRequest(
    input: unknown,
    emit: (event: Record<string, unknown>) => Promise<void>,
    fetcher: typeof fetch,
    session: () => { headers: Record<string, string> },
  ): Promise<void>;
};
test('内置目录来自在线配置，DeepSeek 优先，过滤媒体与自定义模型', () => {
  const models = worker.catalogModels({
    code: 0,
    data: {
      models: [
        { id: 'glm-5.1', name: 'GLM-5.1' },
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'custom-local:grok-4.7' },
        { id: 'hunyuan-image-v3.0-art' },
        { id: 'minimax-video-h3' },
      ],
    },
  });
  assert.deepEqual(models, [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'glm-5.1', name: 'GLM-5.1' },
  ]);
});
test('SSE 只交付正文和服务端型号，忽略思考；截断或工具请求不能冒充完成', () => {
  const stream = worker.chatFrames();
  assert.deepEqual(
    stream.accept('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [], content: '' } }] })),
    [],
  );
  assert.deepEqual(
    stream.accept(
      'data: ' +
        JSON.stringify({
          model: 'deepseek-v4-flash',
          choices: [{ delta: { reasoning_content: 'private reasoning', content: '你好' } }],
        }),
    ),
    [
      { type: 'model', model: 'deepseek-v4-flash' },
      { type: 'text', text: '你好' },
    ],
  );
  assert.throws(() => stream.finish());
  stream.accept('data: [DONE]');
  stream.finish();
  assert.throws(() =>
    worker.chatFrames().accept('data: ' + JSON.stringify({ choices: [{ delta: { tool_calls: [{}] } }] })),
  );
});

test('模型列表沿用在线会话 agent 的可见范围，不把后台内部型号当作可选聊天模型', () => {
  assert.deepEqual(
    worker.catalogModels({
      code: 0,
      data: {
        agents: [{ tags: ['default'], models: ['deepseek-v4-flash', 'glm-5.1'] }],
        models: [
          { id: 'deepseek-v4-flash', name: 'DeepSeek' },
          { id: 'glm-5.1', name: 'GLM' },
          { id: 'default-1.2', name: 'internal' },
          { id: 'codewise-jump' },
        ],
      },
    }),
    [
      { id: 'deepseek-v4-flash', name: 'DeepSeek' },
      { id: 'glm-5.1', name: 'GLM' },
    ],
  );
});
test('WorkBuddy 原生请求只发固定国内站，保留真实角色消息和所选模型，不传工具或任意上游地址', async () => {
  const frames: Record<string, unknown>[] = [];
  const headers = { Authorization: 'Bearer fake_private_token' };
  await worker.runRequest(
    {
      action: 'chat',
      model: 'deepseek-v4-flash',
      maxTokens: 128,
      request: { system: '角色设定', messages: [{ role: 'user', content: '你好' }] },
      url: 'https://untrusted.test',
    },
    async (frame) => {
      frames.push(frame);
    },
    async (url, options) => {
      assert.equal(url, 'https://www.workbuddy.cn/v2/chat/completions');
      assert.equal(options?.redirect, 'error');
      const body = JSON.parse(String(options?.body));
      assert.equal(body.model, 'deepseek-v4-flash');
      assert.equal(body.tools, undefined);
      assert.deepEqual(body.messages, [
        { role: 'system', content: '角色设定' },
        { role: 'user', content: '你好' },
      ]);
      return new Response(
        'data: ' +
          JSON.stringify({ model: 'deepseek-v4-flash', choices: [{ delta: { content: '连接成功' } }] }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
    () => ({ headers }),
  );
  assert.deepEqual(frames, [
    { type: 'model', model: 'deepseek-v4-flash' },
    { type: 'text', text: '连接成功' },
    { type: 'done' },
  ]);
  assert.equal(JSON.stringify(frames).includes('fake_private_token'), false);
  assert.equal(headers.Authorization, '');
});
test('原生错误不回显上游正文，非法自定义模型在取得账户前被拒绝', async () => {
  const input = {
    action: 'chat',
    model: 'deepseek-v4-flash',
    maxTokens: 128,
    request: { system: '', messages: [{ role: 'user', content: '你好' }] },
  };
  await assert.rejects(
    worker.runRequest(
      input,
      async () => {},
      async () => new Response(JSON.stringify({ msg: 'invalid token fake_private_token' }), { status: 401 }),
      () => ({ headers: { Authorization: 'Bearer fake' } }),
    ),
    (e) => e instanceof Error && e.message === 'auth' && !e.message.includes('fake_private_token'),
  );
  assert.throws(() => worker.inputRequest({ ...input, model: 'custom-local:grok-4.7' }));
});
