import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { handleLongTermMemoryRoutes } from './long-term-memory.ts';
import { createLongTermMemory } from '../long-term-memory/service.ts';
import type { PetRouteDeps } from './types.ts';

test('长期记忆管理真实落盘，开关/编辑/删除校验并保留普通聊天边界', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fish-memory-route-'));
  const memory = createLongTermMemory(root, { warn() {} });
  const deps = {
    longTermMemory: memory,
    requirePet: (params: URLSearchParams) =>
      params.get('pet') === 'main'
        ? { ok: true, petId: 'main' }
        : { ok: false, res: { kind: 'json', status: 200, obj: { ok: false, reason: 'unknown-pet' } } },
  } as unknown as PetRouteDeps;
  const call = async (method: string, body?: string, query = 'pet=main') => {
    const result = await handleLongTermMemoryRoutes(deps, {
      method,
      body,
      rest: 'chat/long-term-memory',
      url: new URL('http://localhost/?' + query),
    });
    assert.equal(result?.kind, 'json');
    return result && result.kind === 'json' ? (result.obj as Record<string, unknown>) : {};
  };
  try {
    assert.equal((await call('GET')).enabled, true);
    for (const body of ['{}', 'null', '[]', '{"text":""}', '{"text":"有效信息","path":"elsewhere"}'])
      assert.equal((await call('POST', body)).ok, false);
    assert.equal((await call('POST', '{')).ok, false);
    assert.equal(memory.view('main').facts.length, 0);
    assert.equal((await call('POST', JSON.stringify({ text: '用户希望被称为「星宝」', kind: 'profile' }))).ok, true);
    const id = memory.view('main').facts[0].id;
    await call('POST', JSON.stringify({ id, text: '用户希望被称为「小光」', kind: 'profile' }));
    assert.match(memory.context('main'), /小光/u);
    assert.equal((await call('DELETE')).ok, false, '不能因缺少id而误清空');
    assert.equal((await call('DELETE', undefined, 'pet=main&all=1&id=' + id)).ok, false);
    assert.equal((await call('GET', undefined, 'pet=missing')).reason, 'unknown-pet');
    await call('PUT', '{"enabled":false}');
    assert.equal(memory.context('main'), '');
    assert.equal(memory.view('main').facts.length, 1);
    await call('PUT', '{"enabled":true}');
    await call('DELETE', undefined, 'pet=main&id=' + id);
    assert.equal(memory.view('main').facts.length, 0);
    await call('POST', JSON.stringify({ text: '用户喜欢桌游', kind: 'preference' }));
    await call('DELETE', undefined, 'pet=main&all=1');
    assert.equal(createLongTermMemory(root, { warn() {} }).view('main').facts.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
