/** 真实离屏宠物窗口内发送合成图片；不截图用户桌面、不使用系统输入。 */
const assert = require('node:assert/strict');
module.exports = async ({ windows, origin, petId = 'main' }) => {
  let pet;
  for (const win of windows())
    if (
      !win.isDestroyed() &&
      win.getTitle() !== '桌宠设置' &&
      (await win.webContents.executeJavaScript("!!document.querySelector('.pet-stage')"))
    ) {
      pet = win;
      break;
    }
  assert.ok(pet);
  await pet.webContents.executeJavaScript(`(async()=>{
    window.__miniResult=undefined;const native=window.fetch;
    window.fetch=async(url,init)=>{const response=await native(url,init);if(String(url).includes('/chat?'))void response.clone().json().then(value=>{window.__miniResult={status:response.status,ok:value.ok,reason:value.reason,message:value.message};});return response;};
    const canvas=document.createElement('canvas');canvas.width=64;canvas.height=64;const ctx=canvas.getContext('2d');ctx.fillStyle='#33aa55';ctx.fillRect(0,0,64,64);
    const file=new File([await new Promise(done=>canvas.toBlob(done,'image/png'))],'green.png',{type:'image/png'});
    const encoded=await S.encodeImageFile(file);
    S.mountChatDialog({petId:${JSON.stringify(petId)},surface:'desktop',baseUrl:${JSON.stringify(origin + '/dsh-pet-7340/chat')},x:20,y:20,initialEncoded:encoded});
    const input=document.querySelector('.dsh-pet-chat-input');input.value='这是一张合成测试图片，请只回答收到图片。';input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  })()`);
  let result;
  for (let i = 0; i < 300; i++) {
    await new Promise((done) => setTimeout(done, 100));
    result = await pet.webContents.executeJavaScript('window.__miniResult');
    if (result) break;
  }
  assert.equal(result?.ok, true, JSON.stringify(result));
  assert.equal(result.status, 200);
  assert.equal(await pet.webContents.executeJavaScript("!!document.querySelector('.dsh-pet-chat')"), false);
  assert.equal(pet.isVisible(), false);
  return { ok: true, attachment: 'synthetic64x64', offscreen: true };
};
