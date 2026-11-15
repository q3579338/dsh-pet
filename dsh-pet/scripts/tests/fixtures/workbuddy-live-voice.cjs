/** WorkBuddy 连续语音实测：强制离屏、静音、合成麦克风及独立存档。 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app } = electron,
  RealWindow = electron.BrowserWindow;
const run = process.env.FISH_TEST_RUN;
const report = { offscreen: true, shown: false, nativeCalls: 0 };
report.codexDictationCalls = 0;
report.codexChildren = 0;
report.workbuddyAsrChildren = 0;
const childProcess = require('node:child_process');
const nativeSpawn = childProcess.spawn;
childProcess.spawn = function (file, args, options) {
  if (/(?:^|[\\/])codex\.exe$/i.test(String(file))) report.codexChildren++;
  if (args?.includes('--asr')) report.workbuddyAsrChildren++;
  return nativeSpawn.call(this, file, args, options);
};
Module.syncBuiltinESMExports();
const originalFetch = globalThis.fetch;
globalThis.fetch = (url, init) => {
  if (String(url).includes('/wham/realtime/calls')) report.nativeCalls++;
  if (String(url).includes('chatgpt.com/backend-api/transcribe')) report.codexDictationCalls++;
  return originalFetch(url, init);
};
const HiddenWindow = new Proxy(RealWindow, {
  construct(target, args) {
    const options = args[0] || {};
    const win = new target({
      ...options,
      show: false,
      focusable: false,
      webPreferences: {
        ...options.webPreferences,
        offscreen: true,
        paintWhenInitiallyHidden: true,
        backgroundThrottling: false,
      },
    });
    win.webContents.setAudioMuted(true);
    win.on('show', () => {
      report.shown = true;
    });
    return win;
  },
});
RealWindow.prototype.show = function () {};
RealWindow.prototype.showInactive = function () {};
RealWindow.prototype.focus = function () {};
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  return name === 'electron' ? { ...electron, BrowserWindow: HiddenWindow } : originalLoad.call(this, name, ...args);
};
app.commandLine.appendSwitch('user-data-dir', path.join(run, 'electron'));
app.commandLine.appendSwitch('mute-audio');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const guard = setTimeout(() => {
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ...report, error: 'deadline' }, null, 2));
  app.exit(1);
}, 180000);
(async () => {
  let js;
  try {
    await import(pathToFileURL(path.join(process.env.DSH_PET_NATIVE_COMPANION_ASAR, 'lib/app.js')).href);
    await app.whenReady();
    for (let i = 0; i < 100 && !RealWindow.getAllWindows().length; i++) await wait(100);
    const runtime = JSON.parse(fs.readFileSync(path.join(run, 'home/dsh-pet/standalone-runtime.json')));
    const origin = 'http://127.0.0.1:' + runtime.port;
    const headers = { 'X-DSH-Pet-Token': runtime.token, 'Content-Type': 'application/json' };
    const settings = await (
      await fetch(origin + '/standalone-ai/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocol: 'workbuddy', model: 'deepseek-v4-flash', timeoutMs: 60000 }),
      })
    ).json();
    assert.equal(settings.protocol, 'workbuddy');
    const sample = await fetch(origin + '/dsh-pet-7340/voice/speak', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '测试。', voice: 'windows/zh-CN' }),
    });
    assert.equal(sample.status, 200);
    const b64 = Buffer.from(await sample.arrayBuffer()).toString('base64');
    const wrongSource = await (
      await fetch(origin + '/dsh-pet-7340/voice/hear', {
        method: 'POST',
        headers,
        body: JSON.stringify({ audio: b64, provider: 'codex' }),
      })
    ).json();
    assert.equal(wrongSource.ok, false);
    const recognized = await (
      await fetch(origin + '/dsh-pet-7340/voice/hear', {
        method: 'POST',
        headers,
        body: JSON.stringify({ audio: b64, provider: 'workbuddy' }),
      })
    ).json();
    assert.equal(recognized.ok, true);
    assert.match(recognized.text, /测试/);
    report.workbuddyUploadedRecognition = recognized.text;
    const wrongCall = await (
      await fetch(origin + '/dsh-pet-7340/voice/live/start', {
        method: 'POST',
        headers,
        body: JSON.stringify({ petId: 'main', sdp: 'v=0\ntest', styleId: 'natural' }),
      })
    ).json();
    assert.equal(wrongCall.ok, false);
    app.emit('codex-bigfish:chat');
    let chat;
    for (let i = 0; i < 100; i++) {
      chat = RealWindow.getAllWindows().find((win) => win.getTitle() === '桌宠设置');
      if (chat) break;
      await wait(100);
    }
    assert.ok(chat);
    assert.equal(chat.webContents.isAudioMuted(), true);
    js = (script) => chat.webContents.executeJavaScript(script, true);
    for (let i = 0; i < 120; i++) {
      if (await js("!!document.querySelector('.pet-chat-live-button')")) break;
      await wait(100);
    }
    await js(`(async()=>{
      window.__wb={tracks:[],peers:0,metrics:[],models:[],recognized:[],audios:[],voiceRequests:[],samples:{},failOnce:false};
      const input=document.querySelector('textarea.pet-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'保留这条草稿');input.dispatchEvent(new Event('input',{bubbles:true}));
      document.addEventListener('pet-custom-voice-play',event=>__wb.metrics.push({...event.detail,realSpeechEndMs:performance.now()-__wb.endAt,at:performance.now()}));
      document.addEventListener('pet-voice-model',event=>__wb.models.push(event.detail.model));
      document.addEventListener('pet-voice-recognized',event=>__wb.recognized.push({...event.detail,fromSpeechEndMs:performance.now()-__wb.endAt}));
      const nativePeer=RTCPeerConnection;window.RTCPeerConnection=new Proxy(nativePeer,{construct(target,args){__wb.peers++;return new target(...args)}});
      const nativePlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){this.volume=0;if(this.dataset.petCustomVoice)__wb.audios.push(this);return nativePlay.call(this)};
      const nativeFetch=window.fetch;window.fetch=async(url,init)=>{
        if(/\\/voice\\/(speak|stream)$/.test(String(url))){
          const body=JSON.parse(init.body);if(__wb.failOnce){__wb.failOnce=false;__wb.failedAt=performance.now();return new Response(JSON.stringify({ok:false,message:'test temporary synthesis failure'}),{headers:{'content-type':'application/json'}})}
          const began=performance.now();const response=await nativeFetch(url,init);const row={voice:body.voice,chars:body.text.length,headersMs:performance.now()-began,type:response.headers.get('content-type')};__wb.voiceRequests.push(row);
          void response.clone().arrayBuffer().then(bytes=>{row.bytes=bytes.byteLength;if(row.type?.includes('audio')&&!__wb.samples[body.voice]){let str='';for(const v of new Uint8Array(bytes))str+=String.fromCharCode(v);__wb.samples[body.voice]=btoa(str)}}).catch(()=>{});return response;
        }return nativeFetch(url,init);
      };
      const bytes=Uint8Array.from(atob(${JSON.stringify(b64)}),x=>x.charCodeAt(0));window.__wbContext=new AudioContext();
      const decoded=await __wbContext.decodeAudioData(bytes.buffer),pcm=decoded.getChannelData(0);let first=0,last=pcm.length-1;
      while(first<last&&Math.abs(pcm[first])<.005)first++;while(last>first&&Math.abs(pcm[last])<.005)last--;
      first=Math.max(0,first-Math.round(decoded.sampleRate*.02));last=Math.min(pcm.length-1,last+Math.round(decoded.sampleRate*.02));
      window.__wbSample=__wbContext.createBuffer(1,last-first+1,decoded.sampleRate);__wbSample.copyToChannel(pcm.slice(first,last+1),0);
      navigator.mediaDevices.getUserMedia=async()=>{window.__wbDestination=__wbContext.createMediaStreamDestination();const stream=__wbDestination.stream;__wb.tracks.push(...stream.getTracks());return stream};
      window.__wbSpeak=async()=>{await __wbContext.resume();const source=__wbContext.createBufferSource();source.buffer=__wbSample;source.connect(__wbDestination);await new Promise(done=>{source.onended=()=>{__wb.endAt=performance.now();source.disconnect();done()};source.start()})};
    })()`);
    const until = async (expression, label, limit = 200) => {
      for (let i = 0; i < limit; i++) {
        if (await js(expression)) return;
        await wait(100);
      }
      throw Error(label + ': ' + (await js("document.querySelector('.pet-chat-live-status')?.textContent")));
    };
    const start = async (tone) => {
      await js(
        `(()=>{const select=document.querySelector('.pet-chat-live-tone select');select.value=${JSON.stringify(tone)};select.dispatchEvent(new Event('change',{bubbles:true}))})()`,
      );
      await wait(80);
      await js("document.querySelector('.pet-chat-live-button').click()");
      await until("document.querySelector('.pet-chat-live-status')?.textContent.includes('WorkBuddy ·')", 'call ready');
    };
    const stop = async () => {
      await js("document.querySelector('.pet-chat-live-button').click()");
      await wait(250);
      assert.equal(await js("document.querySelector('.pet-chat-live-button').textContent==='语音聊天'"), true);
      const state = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
      assert.equal(state.sections.voiceSession.data.active, false);
    };
    await start('starbell');
    await js('__wbSpeak()');
    await until('__wb.metrics.length>=1', 'first Starbell reply');
    await js('window.__oldAudios=__wb.audios.slice()');
    await js('__wbSpeak()');
    report.bargeInStoppedOld = await js('__oldAudios.every(audio=>audio.paused)');
    assert.equal(report.bargeInStoppedOld, true);
    await until('__wb.metrics.length>=2', 'second continuous reply');
    await wait(1000);
    await js('__wb.failOnce=true');
    await js('__wbSpeak()');
    await until(
      "document.querySelector('.pet-chat-live-status')?.textContent.includes('这一句未能播放')",
      'recoverable synthesis failure',
    );
    report.keptMicrophoneOnFailure = await js(
      "document.querySelector('.pet-chat-live-button').textContent==='结束语音'&&__wb.tracks.at(-1).readyState==='live'",
    );
    assert.equal(report.keptMicrophoneOnFailure, true);
    await js('__wbSpeak()');
    await until('__wb.metrics.length>=3', 'reply after failed voice');
    await until("!!__wb.samples['bigfish-cute/starbell-v1']", 'complete Starbell sample');
    await stop();
    for (const tone of ['sugarbud', 'dango']) {
      await start(tone);
      await js('__wbSpeak()');
      await until(`__wb.metrics.some(row=>row.voice==='bigfish-cute/${tone}-v1')`, tone + ' actual playback');
      await until(`!!__wb.samples['bigfish-cute/${tone}-v1']`, tone + ' complete sample');
      await stop();
    }
    report.live = await js(
      `({metrics:__wb.metrics,models:__wb.models,recognized:__wb.recognized,voiceRequests:__wb.voiceRequests,peers:__wb.peers,allTracksEnded:__wb.tracks.every(track=>track.readyState==='ended'),draft:document.querySelector('textarea.pet-chat-input').value,micEnabled:!document.querySelector('.pet-chat-mic').disabled})`,
    );
    assert.equal(report.nativeCalls, 0);
    assert.equal(report.codexDictationCalls, 0);
    assert.equal(report.codexChildren, 0);
    assert.ok(report.workbuddyAsrChildren >= 6);
    assert.equal(report.live.peers, 0);
    assert.ok(report.live.models.length >= 5 && report.live.models.every((model) => model === 'deepseek-v4-flash'));
    assert.ok(report.live.recognized.length >= 6 && report.live.recognized.every((row) => /测试/.test(row.text)));
    assert.equal(report.live.draft, '保留这条草稿');
    assert.equal(report.live.allTracksEnded, true);
    assert.equal(report.live.micEnabled, true);
    for (const voice of ['starbell-v1', 'sugarbud-v1', 'dango-v1']) {
      const key = 'bigfish-cute/' + voice;
      const peak = await js(
        `(async()=>{const bytes=Uint8Array.from(atob(__wb.samples[${JSON.stringify(key)}]),x=>x.charCodeAt(0));const decoded=await new OfflineAudioContext(1,1,48000).decodeAudioData(bytes.buffer);let peak=0;for(const v of decoded.getChannelData(0))peak=Math.max(peak,Math.abs(v));return peak})()`,
      );
      assert.ok(peak > 0.001);
      fs.writeFileSync(
        path.join(run, voice + '.mp3'),
        Buffer.from(await js('__wb.samples[' + JSON.stringify(key) + ']'), 'base64'),
      );
    }
    // 快速取消不得留下录音或后台语音会话。
    await js("document.querySelector('.pet-chat-live-button').click()");
    await wait(60);
    await js("document.querySelector('.pet-chat-live-button').click()");
    await wait(1500);
    report.cancelled = await js(
      "document.querySelector('.pet-chat-live-button').textContent==='语音聊天'&&__wb.tracks.every(track=>track.readyState==='ended')",
    );
    assert.equal(report.cancelled, true);
    const memory = path.join(run, 'home/dsh-pet/memory.json');
    report.memoryUntouched = !fs.existsSync(memory) || fs.readFileSync(memory, 'utf8').trim() === '{}';
    assert.equal(report.memoryUntouched, true);
    // 设置顶部来源选择及真实订阅查询：查询 Codex 草稿时，已保存来源仍保持 WorkBuddy。
    await js("document.querySelector('[data-tab=config]').click()");
    for (let i = 0; i < 100; i++) {
      if (await js("!!document.querySelector('#protocol-host button')")) break;
      await wait(100);
    }
    const choose = async (label) => {
      await js("document.querySelector('#protocol-host button').click()");
      await js(
        `[...document.querySelectorAll('[role=option]')].find(option=>option.textContent.includes(${JSON.stringify(label)})).click()`,
      );
      await wait(80);
    };
    await choose('本机 Codex');
    await js("document.querySelector('#balance-btn').click()");
    await until("document.querySelector('#balance-result').dataset.ok==='true'", 'Codex subscription query');
    report.codexBalanceShown = await js("document.querySelector('#balance-result').textContent.includes('Codex')");
    assert.equal(report.codexBalanceShown, true);
    assert.equal((await (await fetch(origin + '/standalone-ai/settings', { headers })).json()).protocol, 'workbuddy');
    await choose('国内版 WorkBuddy');
    await js("document.querySelector('#balance-btn').click()");
    await until("document.querySelector('#balance-result').dataset.ok==='true'", 'WorkBuddy subscription query');
    report.workbuddyBalanceShown = await js(
      "document.querySelector('#balance-result').textContent.includes('WorkBuddy')&&document.querySelector('#balance-result').textContent.includes('积分')",
    );
    assert.equal(report.workbuddyBalanceShown, true);
    report.sourceAtTop = await js(
      "document.querySelector('#panel-config .scroll').firstElementChild.id==='settings'&&document.querySelector('#settings .card').id==='connection-source-card'",
    );
    assert.equal(report.sourceAtTop, true);
    await js("document.querySelector('#save').click()");
    await until("!document.querySelector('#dirty')||document.querySelector('#dirty').hidden", 'save source');
    chat.setSize(390, 844);
    await js("document.querySelector('#panel-config .scroll').scrollTop=0");
    await wait(100);
    fs.writeFileSync(path.join(run, 'source-settings-offscreen.png'), (await chat.webContents.capturePage()).toPNG());
    chat.setSize(390, 844);
    await wait(100);
    fs.writeFileSync(path.join(run, 'workbuddy-live-offscreen.png'), (await chat.webContents.capturePage()).toPNG());
    assert.equal(report.shown, false);
    report.ok = true;
    await fetch(origin + '/dsh-pet-7340/quit', { method: 'POST', headers, body: '{}' });
  } catch (error) {
    report.error = String(error?.stack ?? error?.message ?? error);
    if (js)
      report.status = await js(
        "({status:document.querySelector('.pet-chat-live-status')?.textContent,live:window.__wb?{metrics:__wb.metrics,models:__wb.models,recognized:__wb.recognized,voiceRequests:__wb.voiceRequests}:null})",
      ).catch(() => null);
    report.ok = false;
  } finally {
    clearTimeout(guard);
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
    app.exit(report.ok ? 0 : 1);
  }
})();
