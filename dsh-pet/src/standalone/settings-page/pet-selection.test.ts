import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { petSelectionScript } from './script/pet-selection.ts';
import { petCardScript } from './script/pet-card.ts';

function probe() {
  const state = {
    config: { main: { pets: [{ id: 'main', display: 'none' }] }, mai: { pets: [{ id: 'mai', display: 'desktop' }] } },
    dirtySelection: false,
    dirtyPets: false,
  };
  const context = {
    state,
    byId: () => null,
    markDirty(value: boolean) {
      state.dirtySelection = value;
    },
    calls: 0,
    callApi: async () => {
      context.calls++;
      return state.config;
    },
    setStatus() {},
    initDrafts() {},
    renderPetsPanel() {},
    api: undefined as unknown,
  };
  runInNewContext(
    petSelectionScript() +
      '\nglobalThis.api={initPetSelection,changePetSelectionMode,saveSelectedPets,get:()=>JSON.parse(JSON.stringify(petSelection))};',
    context,
  );
  return {
    context,
    state,
    api: context.api as {
      initPetSelection(config: unknown): void;
      changePetSelectionMode(mode: string): void;
      saveSelectedPets(): Promise<void>;
      get(): { mode: string; ids: string[] };
    },
  };
}

test('初始单宠选当前可见角色，多宠模式可保留单选，切回单宠只留一只', () => {
  const p = probe();
  p.api.initPetSelection(p.state.config);
  assert.equal(p.api.get().mode, 'single');
  assert.equal(p.api.get().ids.join(), 'mai');
  p.api.changePetSelectionMode('multiple');
  assert.equal(p.api.get().mode, 'multiple');
  assert.equal(p.state.dirtySelection, true);
  p.api.initPetSelection({
    main: { desktopPetMode: 'multiple', pets: [{ id: 'main', display: 'both' }] },
    mai: { pets: [{ id: 'mai', display: 'desktop' }] },
  });
  assert.equal(p.api.get().ids.length, 2);
  p.api.changePetSelectionMode('single');
  assert.equal(p.api.get().ids.length, 1);
  p.api.initPetSelection({ main: { desktopPetMode: 'multiple', pets: [{ id: 'main', display: 'desktop' }] } });
  assert.equal(p.api.get().mode, 'multiple');
});

test('已有宠物草稿时拒绝保存显示选择，不吞草稿或向宿主发请求', async () => {
  const p = probe();
  p.api.initPetSelection(p.state.config);
  p.api.changePetSelectionMode('multiple');
  p.state.dirtyPets = true;
  await p.api.saveSelectedPets();
  assert.equal(p.context.calls, 0);
  assert.equal(p.state.dirtyPets, true);
  assert.equal(p.state.dirtySelection, true);
});

test('新增同款按种类生成全局唯一标识，默认不显示，避免自动多出宠物和记忆串档', () => {
  const state = {
    pets: { main: [{ id: 'main' }], mai: [{ id: 'mai' }], other: [{ id: 'mai-2' }] } as Record<
      string,
      Array<{ id: string; display?: string }>
    >,
    entry: 'mai',
    petIndex: 0,
  };
  const context = {
    state,
    currentPets: () => state.pets[state.entry],
    markDirty() {},
    renderPetsPanel() {},
    add: undefined as unknown,
  };
  runInNewContext(petCardScript() + '\nglobalThis.add=addPet;', context);
  (context.add as () => void)();
  assert.equal(state.pets.mai[1].id, 'mai-3');
  assert.equal(state.pets.mai[1].display, 'none');
  state.entry = 'other';
  (context.add as () => void)();
  const ids = Object.values(state.pets)
    .flat()
    .map((p) => p.id);
  assert.equal(new Set(ids).size, ids.length);
});
