import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChatModels, selectChatModel, companionThreadConfig } from './chat-policy.ts';
import { windowsProxyUrl, codexChildEnvironment } from './network.ts';
import { codexFailure } from './errors.ts';

test('chat selects declared model and supported effort, preserving explicit choices', () => {
  const models = parseChatModels([
    {
      model: 'available',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'medium' }],
      defaultReasoningEffort: 'medium',
    },
    { model: 'small', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] },
    { model: 'hidden', hidden: true, supportedReasoningEfforts: [{ reasoningEffort: 'low' }] },
    { model: 'invalid' },
  ]);
  assert.equal(models.length, 2);
  assert.deepEqual(selectChatModel(models, 'default'), {
    id: 'available',
    name: 'available',
    isDefault: true,
    effort: 'medium',
  });
  assert.equal(selectChatModel(models, 'small').effort, 'low');
  assert.throws(() => selectChatModel(models, 'unavailable'), /所选模型/);
});

test('companion tool overrides are thread-local and cover every configured MCP server', () => {
  const original = { mcp_servers: { local: { enabled: true }, remote: { enabled: true } } };
  const config = companionThreadConfig(original);
  assert.equal(config['mcp_servers.local.enabled'], false);
  assert.equal(config['mcp_servers.remote.enabled'], false);
  assert.equal(config['features.shell_tool'], false);
  assert.equal(config['web_search'], 'disabled');
  assert.equal(original.mcp_servers.local.enabled, true);
});

test('Windows proxy parsing prefers HTTPS and never overwrites explicit environment proxies', () => {
  assert.equal(windowsProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890/');
  assert.equal(windowsProxyUrl('http=127.0.0.1:1111;https=127.0.0.1:2222'), 'http://127.0.0.1:2222/');
  assert.equal(windowsProxyUrl('socks=127.0.0.1:7890'), undefined);
  assert.equal(windowsProxyUrl('http://user:secret@proxy.test:80'), undefined);
  const env = { HTTPS_PROXY: 'http://explicit.test:1234', NO_PROXY: 'localhost' };
  assert.deepEqual(codexChildEnvironment(env), env);
  assert.notEqual(codexChildEnvironment(env), env);
});

test('Codex errors expose fixed actionable categories without echoing arbitrary response content', () => {
  assert.match(codexFailure({ message: 'HTTP 401 secret-token' }).message, /登录/);
  assert.match(codexFailure({ message: 'usage limit reached' }).message, /额度/);
  assert.match(codexFailure({ message: 'model not supported' }).message, /模型/);
  assert.match(codexFailure({ message: 'network disconnected' }).message, /网络/);
  assert.doesNotMatch(codexFailure({ message: 'arbitrary-private-content' }).message, /private/);
});
