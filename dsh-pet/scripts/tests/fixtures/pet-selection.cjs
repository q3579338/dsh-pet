/** No foreground windows, system input, sound, real microphone or real user data. */
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  Module = require('node:module');
const { pathToFileURL } = require('node:url');
const electron = require('electron'),
  { app } = electron,
  RealWindow = electron.BrowserWindow;
const run = process.env.FISH_TEST_RUN,
  phase = process.env.PET_SELECTION_PHASE;
const report = { shown: false, dialogs: 0, offscreen: true, muted: true };
const Hidden = new Proxy(RealWindow, {
  construct(target, args) {
    const o = args[0] || {};
    const w = new target({
      ...o,
      show: false,
      focusable: false,
      webPreferences: {
        ...o.webPreferences,
        offscreen: true,
        paintWhenInitiallyHidden: true,
        backgroundThrottling: false,
      },
    });
    w.webContents.setAudioMuted(true);
    w.on('show', () => (report.shown = true));
    return w;
  },
});
RealWindow.prototype.show = function () {};
RealWindow.prototype.showInactive = function () {};
RealWindow.prototype.focus = function () {};
electron.dialog.showMessageBoxSync = () => {
  report.dialogs++;
  return 0;
};
const load = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? { ...electron, BrowserWindow: Hidden } : load.call(this, name, ...args);
};
app.commandLine.appendSwitch('user-data-dir', path.join(run, 'electron'));
app.commandLine.appendSwitch('mute-audio');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const guard = setTimeout(() => {
  fs.writeFileSync(path.join(run, phase + '.json'), JSON.stringify({ ...report, ok: false, error: 'deadline' }));
  app.exit(1);
}, 80000);
(async () => {
  try {
    await import(pathToFileURL(path.join(process.env.DSH_PET_NATIVE_COMPANION_ASAR, 'lib/app.js')).href);
    await app.whenReady();
    let runtime;
    for (let i = 0; i < 100; i++) {
      try {
        runtime = JSON.parse(fs.readFileSync(path.join(run, 'home/dsh-pet/standalone-runtime.json')));
        break;
      } catch {}
      await wait(100);
    }
    assert.ok(runtime);
    const headers = { 'X-DSH-Pet-Token': runtime.token };
    const origin = 'http://127.0.0.1:' + runtime.port;
    const config = async () => await (await fetch(origin + '/dsh-pet-7340/config', { headers })).json();
    const petWindows = async () => {
      let count = 0;
      for (const w of RealWindow.getAllWindows()) {
        if (w.isDestroyed()) continue;
        if (await w.webContents.executeJavaScript("!!document.querySelector('.pet-stage')").catch(() => false)) count++;
      }
      return count;
    };
    const expectWindows = async (n) => {
      for (let i = 0; i < 100; i++) {
        if ((await petWindows()) === n) return;
        await wait(75);
      }
      assert.equal(await petWindows(), n);
    };
    await expectWindows(1);
    app.emit('codex-bigfish:chat', 'config');
    let chat;
    for (let i = 0; i < 100; i++) {
      chat = RealWindow.getAllWindows().find((w) => w.getTitle() === '桌宠设置');
      if (chat) break;
      await wait(80);
    }
    assert.ok(chat);
    const js = (s) => chat.webContents.executeJavaScript(s, true);
    const until = async (s, label) => {
      for (let i = 0; i < 100; i++) {
        if (await js(s)) return;
        await wait(75);
      }
      throw Error('Not ready: ' + label);
    };
    await until("!!document.querySelector('#pet-selection-save')", 'selection card');
    const expectChatTarget = async (name) =>
      until(
        `document.querySelector('.pet-chat-tab[aria-pressed=true]')?.textContent.includes(${JSON.stringify(name)})`,
        'chat target ' + name,
      );
    await expectChatTarget('麦晓雯');
    report.defaultChatTarget = 'maixiaowen';
    await js("document.querySelector('[data-tab=pets]').click()");
    assert.equal(await js("document.querySelector('[data-pet-mode=single]').getAttribute('aria-pressed')"), 'true');
    assert.equal(await js("document.querySelector('input[name=desktop-pet-choice]:checked').value"), 'maixiaowen');
    if (phase === 'switch') {
      const choose = async (id) =>
        js(
          `(()=>{const n=[...document.querySelectorAll('input[name=desktop-pet-choice]')].find(n=>n.value===${JSON.stringify(id)});n.checked=true;n.dispatchEvent(new Event('change',{bubbles:true}))})()`,
        );
      const save = async () => {
        await js("document.querySelector('#pet-selection-save').click()");
        await until("document.querySelector('#pet-selection-status')?.dataset.ok==='true'", 'selection saved');
      };
      await choose('main');
      assert.equal(await js("document.querySelector('#dirty').hidden"), false);
      await save();
      await expectWindows(1);
      await expectChatTarget('原大肥鱼');
      assert.equal((await config()).main.pets[0].display, 'desktop');
      await js("document.querySelector('[data-pet-mode=multiple]').click()");
      await choose('maixiaowen');
      await save();
      await expectWindows(2);
      report.multipleWindows = await petWindows();
      assert.equal((await config()).main.desktopPetMode, 'multiple');
      await expectChatTarget('原大肥鱼');
      await js(
        `(()=>{const input=document.querySelector('textarea.pet-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'切换时保留这条草稿');input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
      );
      const doubleClick = async (id) => {
        for (const w of RealWindow.getAllWindows()) {
          if (w.isDestroyed()) continue;
          if (
            await w.webContents
              .executeJavaScript(`typeof sprites!=='undefined'&&sprites[0]?.pet.id===${JSON.stringify(id)}`)
              .catch(() => false)
          ) {
            await w.webContents.executeJavaScript(
              "document.querySelector('.pet-hit').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))",
            );
            return;
          }
        }
        throw Error('Missing pet window ' + id);
      };
      await doubleClick('maixiaowen');
      await expectChatTarget('麦晓雯');
      assert.equal(await js("document.querySelector('textarea.pet-chat-input').value"), '切换时保留这条草稿');
      await doubleClick('main');
      await expectChatTarget('原大肥鱼');
      assert.equal(await js("document.querySelector('textarea.pet-chat-input').value"), '切换时保留这条草稿');
      report.nativePetTarget = true;
      await js("document.querySelector('[data-tab=pets]').click()");
      await js("document.querySelector('input[name=desktop-pet-choice]:checked').click()");
      await js("document.querySelector('input[name=desktop-pet-choice]:checked').click()");
      assert.equal(await js("document.querySelector('#pet-selection-save').disabled"), true);
      await js(
        "[...document.querySelectorAll('#pet-selection button')].find(b=>b.textContent==='恢复已保存选择').click()",
      );
      await js("document.querySelector('[data-pet-mode=single]').click()");
      await choose('maixiaowen');
      await save();
      await expectWindows(1);
      await expectChatTarget('麦晓雯');
      // A new same-kind instance must appear even while the selection draft is unsaved.
      await js("document.querySelector('[data-pet-mode=multiple]').click()");
      await js(
        "[...document.querySelectorAll('#pet-selection button')].find(b=>b.textContent==='管理同款与更多设置').click()",
      );
      await js("[...document.querySelectorAll('#pet-cards .tab')].find(b=>b.textContent==='maixiaowen').click()");
      await js("[...document.querySelectorAll('#pet-cards button')].find(b=>b.textContent==='新增').click()");
      await js("document.querySelector('#pet-save').click()");
      await until("document.querySelector('#pet-status')?.dataset.ok==='true'", 'new same-kind saved');
      await js("document.querySelector('[data-tab=pets]').click()");
      assert.equal(await js("document.querySelectorAll('input[name=desktop-pet-choice]').length"), 3);
      assert.equal(await js("document.querySelector('[data-pet-mode=multiple]').getAttribute('aria-pressed')"), 'true');
      report.sameKindChoice = true;
      await js("document.querySelector('[data-pet-mode=single]').click()");
      await choose('maixiaowen');
      await save();
      await expectWindows(1);
      chat.setSize(390, 844);
      await wait(150);
      assert.equal(await js('document.documentElement.scrollWidth<=innerWidth'), true);
      assert.equal(await js("document.querySelector('#panel-config .scroll').firstElementChild.id"), 'settings');
      fs.writeFileSync(path.join(run, 'pet-selection-390.png'), (await chat.webContents.capturePage()).toPNG());
      if (process.env.DSH_PET_SELECTION_CHAT === '1') {
        const source = process.env.DSH_PET_SELECTION_CHAT_SOURCE || 'codex';
        const response = await fetch(origin + '/standalone-ai/settings', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            protocol: source,
            model: source === 'codex' ? 'gpt-6-luna' : 'deepseek-v4-flash',
            timeoutMs: 60000,
          }),
        });
        assert.equal(response.status, 200);
        await response.json();
        await js("document.querySelector('[data-tab=chat]').click()");
        report.chatActions = [];
        let previousPlayback;
        for (const [text, action] of [
          ['展示天圆地方', '展示天圆地方'],
          ['拿出一颗非洲之心给我看看', '展示非洲之心'],
        ]) {
          await js(
            `(()=>{const input=document.querySelector('textarea.pet-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,${JSON.stringify(text)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`,
          );
          await wait(50);
          await js("document.querySelector('.pet-chat-send').click()");
          let state, receipt;
          for (let i = 0; i < 400; i++) {
            state = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
            const anim = state.pets.maixiaowen?.anim?.data;
            if (anim?.name === action && anim.playbackId) {
              receipt = await (await fetch(origin + '/dsh-pet-7340/playback/' + anim.playbackId, { headers })).json();
              if (['playing', 'ended'].includes(receipt.status)) break;
            }
            await wait(100);
          }
          assert.ok(['playing', 'ended'].includes(receipt?.status), 'Chat must play ' + action);
          if (process.env.DSH_PET_SELECTION_ANIMATION_HOLD === '1') {
            const playbackId = state.pets.maixiaowen.anim.data.playbackId;
            await wait(3200);
            const held = await (await fetch(origin + '/dsh-pet-7340/playback/' + playbackId, { headers })).json();
            assert.equal(
              held.status,
              'playing',
              'Short clip must still be visibly demonstrating after its first cycle',
            );
            let pet;
            for (const w of RealWindow.getAllWindows())
              if (
                !w.isDestroyed() &&
                (await w.webContents
                  .executeJavaScript("typeof sprites!=='undefined'&&sprites[0]?.pet.id==='maixiaowen'")
                  .catch(() => false))
              ) {
                pet = w;
                break;
              }
            assert.ok(pet);
            const view = await pet.webContents.executeJavaScript(
              "({anim:sprites[0].anim,time:document.querySelector('video.is-front').currentTime,paused:document.querySelector('video.is-front').paused,image:sprites[0].whisperImage,bubbleImages:document.querySelectorAll('.pet-bubble img').length})",
            );
            assert.equal(view.anim, action);
            assert.equal(view.paused, false);
            assert.equal(view.image, '');
            assert.equal(view.bubbleImages, 0);
            await wait(150);
            assert.notEqual(
              await pet.webContents.executeJavaScript("document.querySelector('video.is-front').currentTime"),
              view.time,
              'Demonstration must keep advancing, not freeze on a poster',
            );
            await pet.webContents.executeJavaScript(
              "(()=>{const s=sprites[0];s.pet.workStatusEnabled=true;s.onWorkTick({state:'working',task:'后台任务更新'},s.prevWorkTick+1);s.pet.workStatusEnabled=false})()",
            );
            assert.equal(
              await pet.webContents.executeJavaScript('sprites[0].anim'),
              action,
              'Automatic work animation must yield to the requested showcase',
            );
            assert.equal(
              await pet.webContents.executeJavaScript('sprites[0].workText'),
              '后台任务更新',
              'Work status text must remain current while its animation yields',
            );
            const say = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
            assert.equal(say.pets.maixiaowen.say.data.image, undefined);
            if (previousPlayback) {
              const old = await (
                await fetch(origin + '/dsh-pet-7340/playback/' + previousPlayback, { headers })
              ).json();
              assert.equal(old.status, 'cancelled');
            }
            previousPlayback = playbackId;
            report.demonstrationHeld = true;
            fs.writeFileSync(path.join(run, 'body-' + action + '.png'), (await pet.webContents.capturePage()).toPNG());
          }
          await until("!document.querySelector('.pet-chat-send').classList.contains('is-busy')", 'chat finished');
          report.chatActions.push({ source, pet: 'maixiaowen', action, playback: receipt.status });
        }
        fs.writeFileSync(path.join(run, 'pet-target-chat.png'), (await chat.webContents.capturePage()).toPNG());
        if (previousPlayback) {
          await fetch(origin + '/dsh-pet-7340/bubble/clear?pet=maixiaowen&surface=desktop', {
            method: 'POST',
            headers: { ...headers, 'content-type': 'application/json' },
            body: '{}',
          });
          let receipt;
          for (let i = 0; i < 80; i++) {
            receipt = await (await fetch(origin + '/dsh-pet-7340/playback/' + previousPlayback, { headers })).json();
            if (receipt.status === 'ended') break;
            await wait(100);
          }
          assert.equal(receipt.status, 'ended', 'Clearing the bubble must release the showcase, not loop forever');
          report.showcaseReleased = true;
        }
      }
    }
    const saved = await config();
    assert.equal(saved.main.desktopPetMode, 'single');
    assert.equal(saved.maixiaowen.pets[0].display, 'desktop');
    assert.equal(saved.main.pets[0].display, 'none');
    report.singleWindows = await petWindows();
    report.restarted = phase === 'restart';
    report.ok = true;
  } catch (e) {
    report.ok = false;
    report.error = String(e.stack || e);
  } finally {
    clearTimeout(guard);
    fs.writeFileSync(path.join(run, phase + '.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
})();
