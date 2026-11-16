/** 实际离屏桌宠的气泡与动画回执；使用合成指令，不触碰用户窗口。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ windows, origin, headers, run }) => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let state, receipt, rendered, pet;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
    const anim = state.pets.main?.anim.data;
    if (anim?.name === '吃西瓜' && anim.playbackId)
      receipt = await (await fetch(origin + '/dsh-pet-7340/playback/' + anim.playbackId, { headers })).json();
    for (const win of windows()) {
      if (win.isDestroyed() || win.getTitle() === '桌宠设置') continue;
      const view = await win.webContents.executeJavaScript(
        `(()=>{const bubble=document.querySelector('.pet-bubble.is-on');return bubble?{text:bubble.textContent,clips:[...document.querySelectorAll('video')].map(video=>decodeURIComponent(video.currentSrc).split('/').pop())}:undefined})()`,
      );
      if (view?.text) {
        rendered = view;
        pet = win;
      }
    }
    if (rendered && ['playing', 'ended'].includes(receipt?.status)) break;
    await wait(100);
  }
  assert.equal(state.pets.main?.anim.data?.name, '吃西瓜');
  assert.ok(['playing', 'ended'].includes(receipt?.status), 'Animation must have a renderer playback receipt');
  assert.ok(rendered?.text, 'Voice reply must appear in actual pet bubble');
  assert.doesNotMatch(
    rendered.text,
    /(?:没法|无法|不能).{0,8}(?:吃|动作|表演)/u,
    'Reply must recognize the available desktop animation',
  );
  assert.equal(state.pets.main.say.data.anim, false);
  assert.equal(state.pets.main.say.data.voiceTo, undefined);
  assert.equal(pet.isVisible(), false);
  fs.writeFileSync(path.join(run, 'voice-bubble-action-offscreen.png'), (await pet.webContents.capturePage()).toPNG());
  return {
    bubble: rendered.text,
    animation: receipt.name,
    playbackStatus: receipt.status,
    silentBubble: true,
    offscreen: true,
  };
};
