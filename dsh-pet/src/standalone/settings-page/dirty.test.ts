import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { coreScript } from './script/core.ts';

test('模型保存只清除模型改动，不吞掉尚未保存的宠物设置', () => {
  const badge = { hidden: true };
  const context = {
    document: { getElementById: () => badge },
    URLSearchParams,
    history: { replaceState() {} },
    location: { hash: '', pathname: '/', search: '' },
    probe: undefined as unknown,
  };
  runInNewContext(
    coreScript('/pet', {
      voices: [],
      defaultVoice: '',
      fonts: [],
      displays: [],
      corners: [],
      physics: {},
      font: {},
      weights: {},
    }) + '\nglobalThis.probe={state,markDirty};',
    context,
  );
  const api = context.probe as { state: { dirty: boolean }; markDirty(value: boolean, scope?: string): void };
  api.markDirty(true, 'ai');
  assert.equal(badge.hidden, false);
  api.markDirty(false, 'ai');
  assert.equal(api.state.dirty, false);
  assert.equal(badge.hidden, true);
  api.markDirty(true);
  api.markDirty(true, 'ai');
  api.markDirty(false, 'ai');
  assert.equal(api.state.dirty, true);
  assert.equal(badge.hidden, false);
  api.markDirty(false);
  assert.equal(api.state.dirty, false);
  api.markDirty(true, 'memory');
  api.markDirty(true, 'ai');
  api.markDirty(false, 'ai');
  api.markDirty(false, 'pets');
  assert.equal(api.state.dirty, true, '连接或桌宠保存不能吞掉长期记忆编辑草稿');
  api.markDirty(false, 'memory');
  assert.equal(api.state.dirty, false);
});
