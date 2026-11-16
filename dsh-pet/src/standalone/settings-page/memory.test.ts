import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { memoryScript } from './script/memory.ts';

/** 最小 DOM 仅用于请求时序与草稿测试；实际布局另由离屏 Electron 验证。 */
function fixture(callApi: (method: string, path: string, body?: unknown) => Promise<unknown>) {
  interface Node {
    id: string;
    tag: string;
    value: string;
    textContent: string;
    className: string;
    hidden: boolean;
    disabled: boolean;
    checked: boolean;
    dataset: Record<string, string>;
    children: Node[];
    type: string;
    append(...children: Node[]): void;
    replaceChildren(): void;
    addEventListener(name: string, handler: (event: { preventDefault(): void }) => void): void;
    fire(name: string): void;
    scrollIntoView(): void;
  }
  const all: Node[] = [],
    nodes = new Map<string, Node>();
  function element(id = '', tag = ''): Node {
    const handlers = new Map<string, (event: { preventDefault(): void }) => void>();
    const node: Node = {
      id,
      tag,
      value: id === 'memory-pet' ? 'main' : '',
      textContent: '',
      className: '',
      hidden: false,
      disabled: false,
      checked: false,
      dataset: {} as Record<string, string>,
      children: [] as Node[],
      type: '',
      append(...children: Node[]) {
        node.children.push(...children);
        if (id === 'memory-pet' && !node.value && children[0]) node.value = children[0].value;
      },
      replaceChildren() {
        node.children = [];
        if (id === 'memory-pet') node.value = '';
      },
      addEventListener(name: string, handler: (event: { preventDefault(): void }) => void) {
        handlers.set(name, handler);
      },
      fire(name: string) {
        if (!node.disabled) handlers.get(name)?.({ preventDefault() {} });
      },
      scrollIntoView() {},
    };
    all.push(node);
    return node;
  }
  const byId = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, element(id));
    return nodes.get(id)!;
  };
  for (const id of [
    'memory-pet',
    'memory-enabled',
    'memory-items',
    'memory-status',
    'memory-directory',
    'memory-text',
    'memory-kind',
    'memory-edit-id',
    'memory-save',
    'memory-edit-cancel',
    'memory-refresh',
    'memory-clear',
    'memory-confirm',
    'memory-editor',
    'open-long-term-memory',
  ])
    byId(id);
  const state = { dirtyMemory: false };
  const context = {
    byId,
    state,
    callApi,
    URLSearchParams,
    Event,
    document: {
      createElement: (tag: string) => element('', tag),
      querySelectorAll: () => all.filter((node) => node.id.startsWith('memory-') || node.tag === 'button'),
      dispatchEvent() {},
    },
    markDirty: (value: boolean) => {
      state.dirtyMemory = value;
    },
    selectTab() {},
    probe: undefined as unknown,
  };
  runInNewContext(
    memoryScript() +
      '\nglobalThis.probe={load:loadLongTermMemory,change:changeMemory,paint:paintMemory,wire:wireMemory};',
    context,
  );
  const api = context.probe as {
    load(): Promise<void>;
    change(method: string, extra: string, body?: unknown): Promise<void>;
    paint(body: unknown): void;
    wire(): void;
  };
  api.wire();
  return { api, byId, state };
}
const a = { id: 'a', kind: 'preference', text: '用户喜欢咖啡', ts: 1 },
  b = { id: 'b', kind: 'preference', text: '用户喜欢茶', ts: 2 };
const view = (facts: unknown[]) => ({ ok: true, enabled: true, directory: 'isolated-test', facts });
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};

test('删除另一条记录不能清掉正在编辑的草稿', async () => {
  const f = fixture(async () => view([a]));
  f.api.paint(view([a, b]));
  const row = f.byId('memory-items').children.find((item) => item.dataset.memoryId === 'a')!;
  row.children[2].children[0].fire('click');
  f.byId('memory-text').value = '用户更喜欢绿茶';
  f.byId('memory-text').fire('input');
  await f.api.change('DELETE', '&id=b');
  assert.equal(f.byId('memory-text').value, '用户更喜欢绿茶');
  assert.equal(f.byId('memory-edit-id').value, 'a');
  assert.equal(f.state.dirtyMemory, true);
});
test('保存期间刷新不能启动旧快照读取，控件保持对应当前操作', async () => {
  let resolveWrite!: (value: unknown) => void,
    reads = 0;
  const pending = new Promise<unknown>((resolve) => {
    resolveWrite = resolve;
  });
  const f = fixture(async (method, path) => {
    if (method === 'DELETE') return pending;
    reads++;
    return path === '/config' ? { main: { pets: [{ id: 'main', name: 'Main' }] } } : view([a]);
  });
  f.api.paint(view([a]));
  const operation = f.api.change('DELETE', '&id=a');
  await tick();
  assert.equal(f.byId('memory-pet').disabled, true, '保存时切换宠物可能把操作结果落到错误界面');
  const refresh = f.api.load();
  await tick();
  resolveWrite(view([]));
  await operation;
  await refresh;
  assert.equal(reads, 0, '保存进行中不读可能过期的快照');
  assert.equal(
    f.byId('memory-items').children.some((row) => row.dataset.memoryId === 'a'),
    false,
  );
});
test('删除正在编辑的那一条才清除草稿，取消编辑后恢复宠物选择', async () => {
  const f = fixture(async () => view([]));
  f.api.paint(view([a]));
  f.byId('memory-items').children[0].children[2].children[0].fire('click');
  await f.api.change('DELETE', '&id=a');
  assert.equal(f.byId('memory-text').value, '');
  assert.equal(f.state.dirtyMemory, false);
  assert.equal(f.byId('memory-pet').disabled, false);
});
test('读取失败时仍能取消未保存编辑，不把用户困在无法关闭的草稿里', async () => {
  const f = fixture(async () => {
    throw Error('暂时无法读取');
  });
  f.api.paint(view([a]));
  f.byId('memory-items').children[0].children[2].children[0].fire('click');
  await f.api.load();
  assert.equal(f.byId('memory-edit-cancel').disabled, false);
  assert.equal(f.byId('memory-save').disabled, true);
  f.byId('memory-edit-cancel').fire('click');
  assert.equal(f.state.dirtyMemory, false);
  assert.equal(f.byId('memory-pet').disabled, false);
});
test('有草稿的桌宠被其它窗口移除时，不把草稿自动转给另一只宠物', async () => {
  const f = fixture(async (_method, path) =>
    path === '/config' ? { main: { pets: [{ id: 'other', name: 'Other' }] } } : view([]),
  );
  f.api.paint(view([a]));
  f.byId('memory-text').value = '属于原桌宠的草稿';
  f.byId('memory-text').fire('input');
  await f.api.load();
  assert.equal(f.byId('memory-pet').value, 'main');
  assert.equal(f.byId('memory-text').value, '属于原桌宠的草稿');
  assert.equal(f.byId('memory-save').disabled, true);
  f.byId('memory-edit-cancel').fire('click');
  await f.api.load();
  assert.equal(f.byId('memory-pet').value, 'other');
  assert.equal(f.state.dirtyMemory, false);
});
