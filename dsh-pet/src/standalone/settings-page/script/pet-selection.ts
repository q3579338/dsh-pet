/** 设置页的跨角色桌面显示选择；独立草稿和保存，不改变对话目标或清空其它草稿。 */
export function petSelectionScript(): string {
  return `
let petSelection = { mode: 'single', ids: [] };
let petSelectionBusy = false;
function selectionButton(text, action, attrs) {
  return make('button', { ...attrs, type: 'button', class: 'btn', text, onclick: action });
}
function selectablePets(config = state.config) {
  return Object.entries(config || {}).flatMap(([entry, conf]) =>
    (conf.pets || []).map(pet => ({ ...pet, entry })));
}
function initPetSelection(config) {
  const visible = selectablePets(config).filter(pet => pet.display === 'desktop' || pet.display === 'both').map(pet => pet.id);
  const storedMode = config.main && config.main.desktopPetMode;
  petSelection = { mode: storedMode === 'multiple' || visible.length > 1 ? 'multiple' : 'single', ids: visible };
  renderPetSelection();
}
function changePetSelectionMode(mode) {
  if (petSelectionBusy) return;
  petSelection.mode = mode;
  if (mode === 'single') petSelection.ids = petSelection.ids.slice(0, 1);
  if (!petSelection.ids.length && selectablePets().length) petSelection.ids = [selectablePets()[0].id];
  markDirty(true, 'selection'); renderPetSelection();
}
function renderPetSelection() {
  const host = byId('pet-selection');
  if (!host) return;
  host.textContent = '';
  const choices = selectablePets();
  const buttons = make('div', { class: 'pet-mode-buttons' }, ['single', 'multiple'].map(mode =>
    selectionButton(mode === 'single' ? '单宠 · 只显示一只' : '多宠 · 同时显示多只', () => changePetSelectionMode(mode),
      { disabled: petSelectionBusy, 'aria-pressed': String(petSelection.mode === mode), 'data-pet-mode': mode })));
  const list = make('div', { class: 'pet-choice-list' }, choices.map(pet => {
    const input = make('input', { type: petSelection.mode === 'single' ? 'radio' : 'checkbox', name: 'desktop-pet-choice',
      value: pet.id, checked: petSelection.ids.includes(pet.id), disabled: petSelectionBusy,
      onchange: () => {
        if (petSelectionBusy) return;
        petSelection.ids = petSelection.mode === 'single' ? [pet.id] :
          (input.checked ? [...new Set([...petSelection.ids, pet.id])] : petSelection.ids.filter(id => id !== pet.id));
        markDirty(true, 'selection'); renderPetSelection();
      } });
    return make('label', { class: 'pet-choice' }, [input,
      make('img', { src: API + '/logo?root=' + encodeURIComponent(pet.entry), alt: '', loading: 'lazy' }),
      make('span', { text: pet.name || pet.id })]);
  }));
  const valid = petSelection.ids.length > 0 && (petSelection.mode === 'multiple' || petSelection.ids.length === 1);
  host.append(card('桌面宠物选择', '默认只显示一只；也可以选择多宠一起陪伴。每只宠物的聊天和长期记忆独立保留。', [
    buttons, list,
    make('p', { class: 'fieldHint', text: '已选 ' + petSelection.ids.length + ' 只。选择后点击下方保存，重开仍会保留。' }),
    make('div', { class: 'testRow' }, [
      selectionButton(petSelectionBusy ? '正在保存…' : '保存宠物选择', saveSelectedPets,
        { id: 'pet-selection-save', disabled: petSelectionBusy || !valid }),
      selectionButton('恢复已保存选择', () => { markDirty(false, 'selection'); initPetSelection(state.config); },
        { disabled: petSelectionBusy }),
      selectionButton('管理同款与更多设置', () => { selectTab('config'); byId('pet-cards').scrollIntoView({ block: 'start' }); },
        { disabled: petSelectionBusy }),
    ]), make('p', { class: 'status', id: 'pet-selection-status', role: 'status', 'aria-live': 'polite' }),
  ]));
}
async function saveSelectedPets() {
  if (petSelectionBusy) return;
  if (state.dirtyPets) {
    setStatus(byId('pet-selection-status'), '请先保存下面的桌宠设置，再保存显示选择，避免覆盖未保存的改动。', 'error');
    return;
  }
  petSelectionBusy = true; renderPetSelection();
  const editor = byId('pet-cards'), editorSave = byId('pet-save');
  const editorSaveDisabled = editorSave && editorSave.disabled;
  if (editor) editor.inert = true;
  if (editorSave) editorSave.disabled = true;
  try {
    const merged = await callApi('POST', '/pet-selection', { mode: petSelection.mode, ids: petSelection.ids.slice() });
    if (!merged || merged.ok === false) throw new Error((merged && (merged.message || merged.reason)) || '保存失败，请重试。');
    markDirty(false, 'selection'); initDrafts(merged); renderPetsPanel();
    petSelectionBusy = false; renderPetSelection();
    setStatus(byId('pet-selection-status'), '已保存，桌面显示 ' + petSelection.ids.length + ' 只宠物。', 'ok');
  } catch (error) {
    petSelectionBusy = false; renderPetSelection();
    setStatus(byId('pet-selection-status'), error.message || '保存失败，请重试。', 'error');
  } finally {
    if (editor) editor.inert = false;
    if (editorSave) editorSave.disabled = editorSaveDisabled;
  }
}
`;
}
