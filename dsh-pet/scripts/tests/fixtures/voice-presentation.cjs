/** 实际离屏桌宠的气泡与动画回执；使用合成指令，不触碰用户窗口。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({
  windows,
  origin,
  headers,
  run,
  petId = 'main',
  expected = '吃西瓜',
  hold = false,
  speechCount,
}) => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  let state, receipt, rendered, pet;
  for (let i = 0; i < 100; i++) {
    state = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
    const anim = state.pets[petId]?.anim.data;
    if (anim?.name === expected && anim.playbackId)
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
  assert.equal(state.pets[petId]?.anim.data?.name, expected);
  assert.ok(['playing', 'ended'].includes(receipt?.status), 'Animation must have a renderer playback receipt');
  assert.ok(rendered?.text, 'Voice reply must appear in actual pet bubble');
  assert.doesNotMatch(
    rendered.text,
    /(?:没法|无法|不能).{0,8}(?:吃|动作|表演)/u,
    'Reply must recognize the available desktop animation',
  );
  assert.equal(state.pets[petId].say.data.anim, false);
  assert.equal(state.pets[petId].say.data.voiceTo, undefined);
  assert.equal(state.pets[petId].say.data.image, undefined);
  if (hold) {
    const playbackId = state.pets[petId].anim.data.playbackId;
    const speechBefore = await speechCount();
    await wait(3200);
    receipt = await (await fetch(origin + '/dsh-pet-7340/playback/' + playbackId, { headers })).json();
    assert.equal(receipt.status, 'playing', 'Voice showcase must continue after the short clip ends');
    const visual = await pet.webContents.executeJavaScript(
      "({anim:sprites[0].anim,time:document.querySelector('video.is-front').currentTime,paused:document.querySelector('video.is-front').paused,images:document.querySelectorAll('.pet-bubble img').length})",
    );
    assert.equal(visual.anim, expected);
    assert.equal(visual.paused, false);
    assert.equal(visual.images, 0);
    await wait(120);
    assert.notEqual(
      await pet.webContents.executeJavaScript("document.querySelector('video.is-front').currentTime"),
      visual.time,
    );
    assert.equal(await speechCount(), speechBefore, 'Looping the animation must not submit the speech a second time');
  }
  assert.equal(pet.isVisible(), false);
  fs.writeFileSync(path.join(run, 'voice-bubble-action-offscreen.png'), (await pet.webContents.capturePage()).toPNG());
  return {
    bubble: rendered.text,
    animation: receipt.name,
    playbackStatus: receipt.status,
    silentBubble: true,
    offscreen: true,
    noExtraSpeech: hold,
  };
};
