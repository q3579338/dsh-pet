import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chooseChatPetId } from './pet-target.ts';
import { createPetChatState } from './state.ts';
import type { Pet } from '../../shared/types.ts';
import type { PanelData } from './types.ts';
import type { ChatPanelRuntime } from './runtime.ts';

const pets = [
  { id: 'main', name: '原大肥鱼', display: 'none' },
  { id: 'mai', name: '麦晓雯', display: 'desktop' },
] as Pet[];
test('桌面对话默认选当前显示的麦晓雯，不选排第一但已隐藏的旧角色', () => {
  assert.equal(chooseChatPetId(pets, '', true), 'mai');
  assert.equal(chooseChatPetId(pets, 'main', true, true), 'mai');
  assert.equal(chooseChatPetId(pets, 'main', true), 'main', '仍可手动查看隐藏角色自己的历史');
});
test('多宠保留当前可见对象，浏览器优先自己的可见宠物，全部隐藏时仍可看历史', () => {
  const both = [
    { ...pets[0], display: 'web' },
    { ...pets[1], display: 'both' },
  ] as Pet[];
  assert.equal(chooseChatPetId(both, '', false), 'main');
  assert.equal(chooseChatPetId(both, 'mai', true, true), 'mai');
  assert.equal(
    chooseChatPetId(
      pets.map((p) => ({ ...p, display: 'none' })),
      'mai',
      true,
      true,
    ),
    'mai',
  );
  assert.equal(chooseChatPetId([], '', true), '');
});

function harness() {
  let data: PanelData | undefined;
  let index = 0;
  const refs: Array<{ current: unknown }> = [];
  const runtime = {
    h() {},
    t: (key: string) => key,
    useEffect() {},
    useState(init: PanelData) {
      data ??= init;
      return [
        data,
        (next: PanelData | ((prev: PanelData) => PanelData)) => {
          data = typeof next === 'function' ? next(data!) : next;
        },
      ];
    },
    useRef(initial: unknown) {
      const at = index++;
      refs[at] ??= { current: initial };
      return refs[at];
    },
  } as unknown as ChatPanelRuntime;
  const hook = createPetChatState(runtime);
  const render = () => {
    index = 0;
    return hook();
  };
  render();
  data = { ...data!, pets, petId: 'main', loading: false, draft: '旧角色的问题' };
  return { render };
}
const settle = () => new Promise((done) => setTimeout(done, 5));
const history = (name: string) => Response.json({ messages: [{ role: 'assistant', content: name, ts: 1 }] });

test('切换后又切回时，旧发送响应不会清掉新草稿或解除新请求的忙碌状态', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let finish: (response: Response) => void = () => {};
  globalThis.fetch = (async (_url, init) =>
    init?.method === 'POST'
      ? new Promise<Response>((done) => {
          finish = done;
        })
      : history('正确历史')) as typeof fetch;
  const h = harness();
  h.render().send();
  h.render().pickPet('mai');
  await settle();
  h.render().pickPet('main');
  await settle();
  h.render().setDraft('切回来后新写的内容');
  finish(Response.json({ ok: true }));
  await settle();
  assert.equal(h.render().draft, '切回来后新写的内容');
  assert.equal(h.render().petId, 'main');
});

test('旧角色迟到的历史不会盖掉当前角色的头像和消息', async (t) => {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  let finish: (response: Response) => void = () => {};
  globalThis.fetch = (async (url) =>
    new URL(String(url), 'http://localhost').searchParams.get('pet') === 'mai'
      ? new Promise<Response>((done) => {
          finish = done;
        })
      : history('原角色历史')) as typeof fetch;
  const h = harness();
  h.render().pickPet('mai');
  h.render().pickPet('main');
  await settle();
  finish(history('麦晓雯历史'));
  await settle();
  assert.equal(h.render().petId, 'main');
  assert.equal(h.render().messages[0].text, '原角色历史');
});
