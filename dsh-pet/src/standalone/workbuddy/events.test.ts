import assert from 'node:assert/strict';
import { test } from 'node:test';
import { workBuddyEvents, parseWorkBuddyModels } from './events.ts';
test('WorkBuddy 管道只传目录、型号和正文，完成前断流不能计为成功', () => {
  const events = workBuddyEvents();
  assert.deepEqual(events.accept('{"type":"model","model":"deepseek-v4-flash"}'), { modelUsed: 'deepseek-v4-flash' });
  assert.deepEqual(events.accept('{"type":"text","text":"连接成功"}'), { text: '连接成功' });
  assert.throws(() => events.finish(), /未完整/u);
  events.accept('{"type":"done"}');
  events.finish();
  assert.throws(() => events.accept('{"type":"done"}'), /重复/u);
});
test('WorkBuddy 认证失败不作为文字，任意上游错误和凭据字段不回显', () => {
  assert.throws(
    () => workBuddyEvents().accept('{"type":"error","code":"auth","token":"secret"}'),
    (e) => e instanceof Error && /登录/u.test(e.message) && !e.message.includes('secret'),
  );
  assert.throws(() => workBuddyEvents().accept('{"type":"auth","accessToken":"secret"}'), /无法识别/u);
  assert.throws(() => workBuddyEvents().accept('{broken secret'), /格式/u);
  assert.throws(() => workBuddyEvents().accept(JSON.stringify({ type: 'text', text: 'x'.repeat(16385) })), /过长/u);
});
test('只返回内置模型及名字，不接收自定义 ID、地址或其它账号字段', () => {
  assert.deepEqual(
    parseWorkBuddyModels([
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', token: 'secret' },
      { id: 'glm-5.1' },
      { id: 'deepseek-v4-flash' },
      { id: 'custom-local:grok-4.7' },
      { id: 'https://invalid?q=secret' },
    ]),
    [
      { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
      { id: 'glm-5.1', name: 'glm-5.1' },
    ],
  );
  assert.throws(() => parseWorkBuddyModels([]), /没有返回/u);
});
