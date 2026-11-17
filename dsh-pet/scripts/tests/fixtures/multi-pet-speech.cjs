/** All windows stay offscreen and muted; logical visibility changes never show or focus them. */
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  Module = require('node:module');
const { pathToFileURL } = require('node:url');
const electron = require('electron'),
  { app } = electron,
  RealWindow = electron.BrowserWindow;
const run = process.env.FISH_TEST_RUN;
const report = { shown: false, offscreen: true, muted: true, pets: [], chatReplies: [] };
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
const load = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? { ...electron, BrowserWindow: Hidden } : load.call(this, name, ...args);
};
app.commandLine.appendSwitch('user-data-dir', path.join(run, 'electron'));
app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const guard = setTimeout(() => {
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ...report, ok: false, error: 'deadline' }));
  app.exit(1);
}, 170000);
const views = new Map();
const readViews = async () => {
  const rows = [];
  for (const [id, w] of views)
    rows.push({
      id,
      ...(await w.webContents.executeJavaScript(
        '({hidden:document.hidden,requests:__multi.requests,plays:__multi.plays,ended:__multi.ended,text:sprites[0].whisperText})',
      )),
    });
  return rows;
};
(async () => {
  try {
    await import(pathToFileURL(path.join(process.env.DSH_PET_NATIVE_COMPANION_ASAR, 'lib/app.js')).href);
    await app.whenReady();
    let runtime;
    for (let i = 0; i < 120; i++) {
      try {
        runtime = JSON.parse(fs.readFileSync(path.join(run, 'home/dsh-pet/standalone-runtime.json')));
      } catch {}
      for (const w of RealWindow.getAllWindows()) {
        const id = await w.webContents
          .executeJavaScript("typeof sprites!=='undefined'&&sprites[0]?.pet.id")
          .catch(() => null);
        if (id && (await w.webContents.executeJavaScript("typeof stateBaseline!=='undefined'&&stateBaseline!==null")))
          views.set(id, w);
      }
      if (runtime && views.size === 3) break;
      await wait(100);
    }
    assert.equal(views.size, 3);
    const origin = 'http://127.0.0.1:' + runtime.port;
    const headers = { 'X-DSH-Pet-Token': runtime.token, 'Content-Type': 'application/json' };
    const post = async (route, body) => {
      const response = await fetch(origin + route, { method: 'POST', headers, body: JSON.stringify(body) });
      const result = await response.json();
      assert.notEqual(result.ok, false, route + ': ' + result.message);
      return result;
    };
    for (const [id, w] of views) {
      await w.webContents.executeJavaScript(`(()=>{
        window.__multi={hidden:${id !== 'main'},requests:[],plays:0,ended:0,flipOnSpeech:false};
        Object.defineProperty(document,'hidden',{configurable:true,get:()=>__multi.hidden});
        const play=HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play=function(){this.volume=0;if(this instanceof HTMLAudioElement){__multi.plays++;this.addEventListener('ended',()=>__multi.ended++,{once:true})}return play.call(this)};
        const nativeFetch=window.fetch;
        window.fetch=async(url,init)=>{
          if(!String(url).endsWith('/voice/speak'))return nativeFetch(url,init);
          const row={text:JSON.parse(init.body).text};__multi.requests.push(row);
          if(__multi.flipOnSpeech){__multi.flipOnSpeech=false;__multi.hidden=true;document.dispatchEvent(new Event('visibilitychange'))}
          const response=await nativeFetch(url,init);
          void response.clone().arrayBuffer().then(async bytes=>{const decoded=await new OfflineAudioContext(1,1,48000).decodeAudioData(bytes);let peak=0;for(const sample of decoded.getChannelData(0))peak=Math.max(peak,Math.abs(sample));row.nonSilent=peak>.001}).catch(()=>row.failed=true);
          return response;
        };
      })()`);
      assert.equal(w.isVisible(), false);
    }
    const texts = { main: '蓝毛一号的声音测试。', 'main-2': '蓝毛二号的声音测试。', maixiaowen: '麦晓雯的声音测试。' };
    await Promise.all(
      [...views.keys()].map((id) =>
        post('/dsh-pet-7340/broadcast?pet=' + id + '&surface=desktop', { text: texts[id], speak: true, anim: false }),
      ),
    );
    for (let i = 0; i < 150; i++) {
      report.pets = await readViews();
      if (report.pets.every((row) => row.ended === 1 && row.requests[0]?.nonSilent)) break;
      await wait(100);
    }
    for (const row of report.pets) {
      assert.equal(row.text, texts[row.id]);
      assert.equal(row.requests.length, 1, row.id + ' must synthesize exactly once');
      assert.equal(row.plays, 1, row.id + ' must actually play even while occluded');
      assert.equal(row.ended, 1, row.id + ' must finish its audio');
      row.initialPlays = row.plays;
      row.nonSilentAudio = row.requests[0].nonSilent;
    }
    if (process.env.DSH_PET_MULTI_CHAT === '1') {
      const source = process.env.DSH_PET_CONVERSATION_SOURCE === 'workbuddy' ? 'workbuddy' : 'codex';
      await post('/standalone-ai/settings', {
        protocol: source,
        model: source === 'codex' ? 'gpt-6-luna' : 'deepseek-v4-flash',
        timeoutMs: 60000,
      });
      for (const [id, w] of views) {
        const before = await readViews();
        const reply = await post('/dsh-pet-7340/chat?pet=' + id + '&surface=any', {
          text: '只用一句十个字以内的话向我打招呼。',
        });
        assert.equal(reply.ok, true);
        const state = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
        report.chatAttempts ??= [];
        report.chatAttempts.push({ petId: id, reply, say: state.pets[id]?.say.data });
        assert.ok(reply.text, id + ' must have a spoken text reply');
        for (let i = 0; i < 200; i++) {
          const now = await w.webContents.executeJavaScript('({plays:__multi.plays,ended:__multi.ended})');
          if (now.plays > before.find((row) => row.id === id).plays && now.ended === now.plays) break;
          await wait(100);
        }
        const after = await readViews();
        for (const row of after) {
          const previous = before.find((old) => old.id === row.id);
          if (row.id === id) {
            assert.ok(row.plays > previous.plays, id + ' chat reply must play');
            assert.equal(row.ended, row.plays);
          } else assert.equal(row.plays, previous.plays, 'Other pets must not repeat this reply');
        }
        report.chatReplies.push({ petId: id, source, played: true });
      }
    }
    const first = views.get('main');
    const before = await first.webContents.executeJavaScript('__multi.plays');
    await first.webContents.executeJavaScript('__multi.hidden=false;__multi.flipOnSpeech=true');
    await post('/dsh-pet-7340/broadcast?pet=main&surface=desktop', {
      text: '合成时被遮挡也要读完。',
      speak: true,
      anim: false,
    });
    for (let i = 0; i < 150; i++) {
      if (await first.webContents.executeJavaScript(`__multi.plays>${before}&&__multi.ended===__multi.plays`)) break;
      await wait(100);
    }
    report.occludedDuringSynthesis = await first.webContents.executeJavaScript(
      `document.hidden&&__multi.plays>${before}&&__multi.ended===__multi.plays`,
    );
    assert.equal(report.occludedDuringSynthesis, true);
    const initialPlays = new Map(report.pets.map((row) => [row.id, row.initialPlays]));
    report.pets = (await readViews()).map((row) => ({
      ...row,
      initialPlays: initialPlays.get(row.id),
      nonSilentAudio: row.requests.some((item) => item.nonSilent),
    }));
    assert.equal(report.shown, false);
    report.ok = true;
  } catch (error) {
    report.lastViews = await readViews().catch(() => []);
    report.error = String(error.stack || error);
    report.ok = false;
  } finally {
    clearTimeout(guard);
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
})();
