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
      assert.equal((await config()).main.pets[0].display, 'desktop');
      await js("document.querySelector('[data-pet-mode=multiple]').click()");
      await choose('maixiaowen');
      await save();
      await expectWindows(2);
      report.multipleWindows = await petWindows();
      assert.equal((await config()).main.desktopPetMode, 'multiple');
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
