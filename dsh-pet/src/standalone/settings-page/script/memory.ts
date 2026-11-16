/** 长期记忆界面只用 textContent，不把模型或用户文本当 HTML；访问页面时才加载。 */
export function memoryScript(): string {
  return `
let memoryLoading = false;
let memoryReadSerial = 0;
let memoryReady = false;
let memoryRenderedPet = '';
const MEMORY_LABELS = {profile:'称呼与个人信息',preference:'喜好',promise:'约定',relationship:'关系',event:'重要事件',lesson:'习惯与经验'};
function memoryUrl(extra) { return '/chat/long-term-memory?pet=' + encodeURIComponent(byId('memory-pet').value) + (extra || ''); }
function memoryStatus(message, error) { const node=byId('memory-status'); node.textContent=message; node.dataset.error=error?'true':''; }
function syncMemoryControls() {
  const locked=memoryLoading||!memoryReady||memoryRenderedPet!==byId('memory-pet').value;
  for(const node of document.querySelectorAll('#panel-memory button,#panel-memory input,#panel-memory textarea,#panel-memory select'))node.disabled=locked;
  byId('memory-refresh').disabled=memoryLoading;
  byId('memory-pet').disabled=memoryLoading||state.dirtyMemory;
  byId('memory-edit-cancel').disabled=memoryLoading;
}
function resetMemoryEditor() { byId('memory-edit-id').value=''; byId('memory-text').value=''; byId('memory-save').textContent='保存这条记忆'; byId('memory-edit-cancel').hidden=true;markDirty(false,'memory');syncMemoryControls(); }
function paintMemory(body,pet=byId('memory-pet').value) {
  memoryRenderedPet=pet;memoryReady=true;
  byId('memory-enabled').checked=body.enabled===true;
  byId('memory-directory').textContent='保存位置：'+body.directory;
  const host=byId('memory-items'); host.replaceChildren();
  const facts=body.facts || [];
  if (!facts.length) {const empty=document.createElement('p');empty.className='cardHint';empty.textContent='还没有长期记忆。可以聊聊你的称呼、喜好或约定，也可以手动补充。';host.append(empty);}
  facts.slice().sort((a,b)=>b.ts-a.ts).forEach((fact)=>{
    const row=document.createElement('article');row.className='memory-item';row.dataset.memoryId=fact.id;
    const meta=document.createElement('p');meta.className='fieldHint';meta.textContent=(MEMORY_LABELS[fact.kind]||'信息')+' · '+new Date(fact.ts).toLocaleString();
    const text=document.createElement('p');text.className='memory-fact';text.textContent=fact.text;
    const actions=document.createElement('div');actions.className='memory-actions';
    const edit=document.createElement('button');edit.type='button';edit.className='btn';edit.textContent='修改';edit.addEventListener('click',()=>{if(memoryLoading||!memoryReady)return;if(state.dirtyMemory)return memoryStatus('请先保存或取消正在编辑的记忆。',true);byId('memory-edit-id').value=fact.id;byId('memory-text').value=fact.text;byId('memory-kind').value=fact.kind;byId('memory-save').textContent='保存修改';byId('memory-edit-cancel').hidden=false;markDirty(true,'memory');syncMemoryControls();byId('memory-editor').scrollIntoView({block:'nearest'});});
    const remove=document.createElement('button');remove.type='button';remove.className='btn';remove.textContent='删除';remove.addEventListener('click',()=>confirmMemoryDelete(fact.id));
    actions.append(edit,remove);row.append(meta,text,actions);host.append(row);
  });
  memoryStatus('已读取 '+facts.length+' 条。'+(body.enabled?'自动提取已开启。':'自动提取和使用已关闭。'));
  syncMemoryControls();
}
async function loadLongTermMemory() {
  if(memoryLoading)return;
  const serial=++memoryReadSerial;
  memoryReady=false;syncMemoryControls();
  try {
    memoryStatus('正在读取本机长期记忆…');
    const config=await callApi('GET','/config');
    if(serial!==memoryReadSerial)return;
    const select=byId('memory-pet'),previous=select.value,seen=new Set(),options=[];
    Object.values(config).forEach((group)=>{(group&&Array.isArray(group.pets)?group.pets:[]).forEach((pet)=>{if(!pet.id||seen.has(pet.id))return;seen.add(pet.id);const option=document.createElement('option');option.value=pet.id;option.textContent=pet.name||pet.id;options.push(option);});});
    if(state.dirtyMemory&&previous&&!seen.has(previous))throw Error('正在编辑的桌宠已移除，请先复制草稿或取消修改，再选择其它桌宠。');
    select.replaceChildren();for(const option of options)select.append(option);
    if(seen.has(previous))select.value=previous;
    if(!select.value)throw Error('请先添加一只桌宠。');
    const pet=select.value;
    const body=await callApi('GET',memoryUrl());
    if(!body||body.ok!==true)throw Error(body&&body.message||'长期记忆读取失败，请刷新重试。');
    if(serial===memoryReadSerial&&pet===byId('memory-pet').value)paintMemory(body,pet);
  } catch(error) {if(serial===memoryReadSerial)memoryStatus(error.message||'记忆读取失败，请刷新重试。',true);}
  finally {if(serial===memoryReadSerial)syncMemoryControls();}
}
async function changeMemory(method,extra,body) {
  if(memoryLoading)return;
  if(!memoryReady||memoryRenderedPet!==byId('memory-pet').value)return memoryStatus('请先读取当前桌宠的记忆。',true);
  memoryLoading=true;const serial=++memoryReadSerial;
  memoryStatus('正在保存本机记忆…');
  syncMemoryControls();
  const pet=byId('memory-pet').value;
  try {
    const result=await callApi(method,memoryUrl(extra),body);
    if(!result||result.ok!==true)throw Error(result&&result.message||'长期记忆未能保存，请重试。');
    document.dispatchEvent(new Event('pet-stop-live-voice'));
    if(byId('memory-pet').value===pet&&serial===memoryReadSerial){paintMemory(result,pet);const edited=byId('memory-edit-id').value,deleted=new URLSearchParams(extra||'').get('id');if(method==='POST'||(method==='DELETE'&&edited&&(!deleted||deleted===edited)))resetMemoryEditor();byId('memory-confirm').hidden=true;memoryStatus('已保存到本机。重新开始语音会载入最新记忆。');}
  } catch(error){if(byId('memory-pet').value===pet&&serial===memoryReadSerial){if(method==='PUT'&&body)byId('memory-enabled').checked=!body.enabled;memoryStatus(error.message||'记忆修改失败，请重试。',true);}}
  finally {memoryLoading=false;if(byId('memory-pet').value!==pet){memoryReady=false;loadLongTermMemory();}else syncMemoryControls();}
}
function confirmMemoryDelete(id) {
  if(memoryLoading||!memoryReady||memoryRenderedPet!==byId('memory-pet').value)return;
  const pet=byId('memory-pet').value;
  const host=byId('memory-confirm');host.replaceChildren();host.hidden=false;
  const message=document.createElement('p');message.textContent=id?'确定删除这条长期记忆？':'确定清空这只桌宠的全部长期记忆？普通聊天记录保留。';
  const yes=document.createElement('button');yes.type='button';yes.className='btn';yes.textContent='确定删除';yes.addEventListener('click',()=>{if(byId('memory-pet').value===pet)changeMemory('DELETE',id?'&id='+encodeURIComponent(id):'&all=1');else host.hidden=true;});
  const no=document.createElement('button');no.type='button';no.className='btn';no.textContent='取消';no.addEventListener('click',()=>{host.hidden=true;});host.append(message,yes,no);host.scrollIntoView({block:'nearest'});
}
function wireMemory() {
  byId('memory-text').addEventListener('input',()=>{const dirty=!!byId('memory-text').value.trim()||!!byId('memory-edit-id').value;markDirty(dirty,'memory');syncMemoryControls();byId('memory-edit-cancel').hidden=!dirty;});
  byId('open-long-term-memory').addEventListener('click',()=>selectTab('memory'));
  byId('memory-refresh').addEventListener('click',loadLongTermMemory);
  byId('memory-pet').addEventListener('change',()=>{resetMemoryEditor();byId('memory-confirm').hidden=true;loadLongTermMemory();});
  byId('memory-enabled').addEventListener('change',()=>changeMemory('PUT','',{enabled:byId('memory-enabled').checked}));
  byId('memory-clear').addEventListener('click',()=>confirmMemoryDelete());
  byId('memory-edit-cancel').addEventListener('click',resetMemoryEditor);
  byId('memory-editor').addEventListener('submit',(event)=>{event.preventDefault();const id=byId('memory-edit-id').value;changeMemory('POST','',{text:byId('memory-text').value,kind:byId('memory-kind').value,...(id?{id}: {})});});
  syncMemoryControls();
}
`;
}
