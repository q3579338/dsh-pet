/** 即时语音验收：独立存档、强制离屏、静音，麦克风仅接合成的“测试”短句。 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app } = electron;
const run = process.env.FISH_TEST_RUN;
const RealWindow = electron.BrowserWindow;
const report = { offscreen: true, shown: false };
let closeChoice = 0;
const HiddenWindow = new Proxy(RealWindow, {
  construct(target, args) {
    const options = args[0] || {};
    const window = new target({
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
    window.webContents.setAudioMuted(true);
    return window;
  },
});
RealWindow.prototype.show = function () {};
RealWindow.prototype.showInactive = function () {};
RealWindow.prototype.focus = function () {};
const originalLoad = Module._load;
const wrapped = { ...electron, BrowserWindow: HiddenWindow };
wrapped.dialog = { ...electron.dialog, showMessageBoxSync: () => closeChoice };
Module._load = function (name, ...args) {
  return name === 'electron' ? wrapped : originalLoad.call(this, name, ...args);
};
app.commandLine.appendSwitch('user-data-dir', path.join(run, 'electron'));
app.commandLine.appendSwitch('mute-audio');
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const guard = setTimeout(() => {
  fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ ...report, error: 'deadline' }, null, 2));
  app.exit(1);
}, 75000);
(async () => {
  try {
    await import(pathToFileURL(path.join(process.env.DSH_PET_NATIVE_COMPANION_ASAR, 'lib/app.js')).href);
    await app.whenReady();
    for (let i = 0; i < 100 && !RealWindow.getAllWindows().length; i++) await wait(100);
    const runtime = JSON.parse(fs.readFileSync(path.join(run, 'home/dsh-pet/standalone-runtime.json')));
    const origin = 'http://127.0.0.1:' + runtime.port;
    const headers = { 'X-DSH-Pet-Token': runtime.token, 'Content-Type': 'application/json' };
    const sample = await fetch(origin + '/dsh-pet-7340/voice/speak', {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: '测试。', voice: 'windows/zh-CN' }),
    });
    assert.equal(sample.status, 200);
    const b64 = Buffer.from(await sample.arrayBuffer()).toString('base64');
    const dictation = await (
      await fetch(origin + '/dsh-pet-7340/voice/hear', {
        method: 'POST',
        headers,
        body: JSON.stringify({ audio: b64, provider: 'codex' }),
      })
    ).json();
    assert.equal(dictation.ok, true, dictation.message);
    assert.match(dictation.text, /测试/);
    report.dictation = dictation.text;
    app.emit('codex-bigfish:chat');
    let chat;
    for (let i = 0; i < 100; i++) {
      chat = RealWindow.getAllWindows().find((win) => win.getTitle() === '桌宠设置');
      if (chat) break;
      await wait(100);
    }
    assert.ok(chat);
    const js = (source) => chat.webContents.executeJavaScript(source, true);
    for (let i = 0; i < 100; i++) {
      if (await js("!!document.querySelector('.pet-chat-live-button')")) break;
      await wait(100);
    }
    report.hasButton = await js("!!document.querySelector('.pet-chat-live-button')");
    assert.equal(report.hasButton, true);
    await js(`(async()=>{
      window.__live={tracks:[],peers:[],played:0,requests:0,blobs:[],inputs:0,turns:0};
      const buffer=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));
      window.__ctx=new AudioContext();window.__sample=await __ctx.decodeAudioData(buffer.buffer);
      navigator.mediaDevices.getUserMedia=async()=>{
        __live.requests++;window.__out=__ctx.createMediaStreamDestination();__live.tracks.push(...__out.stream.getTracks());return __out.stream;
      };
      window.__speakLiveSample=async()=>{const source=__ctx.createBufferSource();source.buffer=__sample;source.connect(__out);await __ctx.resume();source.start();};
      const RealPeer=RTCPeerConnection;window.RTCPeerConnection=new Proxy(RealPeer,{construct(target,args){
        const peer=new target(...args);__live.peers.push(peer);
        const createChannel=peer.createDataChannel.bind(peer);peer.createDataChannel=(...args)=>{const channel=createChannel(...args);channel.addEventListener('message',event=>{const value=JSON.parse(event.data);if(value.type==='input_transcript.added')__live.inputs++;if(value.type==='turn.done'&&value.turn.role==='assistant')__live.turns++;});return channel;};
        peer.addEventListener('track',event=>{
          const stream=event.streams[0]||new MediaStream([event.track]);window.__recorder=new MediaRecorder(stream);
          __recorder.ondataavailable=event=>{if(event.data.size)__live.blobs.push(event.data);};__recorder.start(500);
        });return peer;
      }});
      const originalPlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){this.volume=0;return originalPlay.call(this).then(()=>{if(this.srcObject)__live.played++;});};
      const input=document.querySelector('textarea.pet-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'保留这条草稿');input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('.pet-chat-live-button').click();
    })()`);
    for (let i = 0; i < 400; i++) {
      const status = await js(
        "({button:document.querySelector('.pet-chat-live-button').textContent,status:document.querySelector('.pet-chat-live-status')?.textContent,connected:window.__live.peers[0]?.connectionState})",
      );
      if (status.connected === 'connected' && status.status?.includes('可以直接说话')) break;
      if (status.button === '即时语音' && status.status) throw Error(status.status);
      await wait(100);
    }
    report.connected = await js("__live.peers[0]?.connectionState==='connected'");
    assert.equal(report.connected, true);
    await js('__speakLiveSample()');
    for (let i = 0; i < 180; i++) {
      if (await js("!!document.querySelector('.pet-chat-live-pet')?.textContent")) break;
      await wait(100);
    }
    await wait(3500);
    await js('__speakLiveSample()');
    for (let i = 0; i < 180; i++) {
      if (await js('__live.inputs>=2 && __live.turns>=2')) break;
      await wait(100);
    }
    await wait(1500);
    report.live = await js(`(async()=>{
      if(window.__recorder?.state!=='inactive')await new Promise(done=>{__recorder.onstop=done;__recorder.stop();});
      const bytes=await new Blob(__live.blobs).arrayBuffer();const recordedBytes=bytes.byteLength;let peak=0;
      if(bytes.byteLength){const decoded=await new OfflineAudioContext(1,1,48000).decodeAudioData(bytes);for(const value of decoded.getChannelData(0))peak=Math.max(peak,Math.abs(value));}
      return {user:document.querySelector('.pet-chat-live-user')?.textContent,pet:document.querySelector('.pet-chat-live-pet')?.textContent,played:__live.played,recordedBytes,peak,inputs:__live.inputs,turns:__live.turns,requests:__live.requests,draft:document.querySelector('textarea.pet-chat-input').value,microphoneDisabled:document.querySelector('.pet-chat-mic').disabled};
    })()`);
    assert.match(report.live.user, /测试/);
    assert.ok(report.live.pet);
    assert.ok(report.live.played > 0);
    assert.ok(report.live.peak > 0.001);
    assert.ok(report.live.inputs >= 2 && report.live.turns >= 2);
    assert.equal(report.live.draft, '保留这条草稿');
    assert.equal(report.live.microphoneDisabled, true);
    chat.setSize(400, 800);
    await wait(150);
    fs.writeFileSync(path.join(run, 'live-offscreen.png'), (await chat.webContents.capturePage()).toPNG());
    await js("document.querySelector('.pet-chat-live-button').click()");
    await wait(300);
    report.stopped = await js(
      "({ended:__live.tracks.every(track=>track.readyState==='ended'),closed:__live.peers.every(peer=>peer.connectionState==='closed'),audioReleased:[...document.querySelectorAll('audio')].every(audio=>audio.srcObject===null),canRecord:!document.querySelector('.pet-chat-mic').disabled,draft:document.querySelector('textarea.pet-chat-input').value})",
    );
    assert.equal(report.stopped.ended, true);
    assert.equal(report.stopped.closed, true);
    assert.equal(report.stopped.audioReleased, true);
    assert.equal(report.stopped.canRecord, true);
    assert.equal(report.stopped.draft, '保留这条草稿');
    const state = await (await fetch(origin + '/dsh-pet-7340/state', { headers })).json();
    report.hostReleased = state.sections.voiceSession.data.active === false;
    assert.equal(report.hostReleased, true);
    await js("document.querySelector('.pet-chat-live-button').click()");
    for (let i = 0; i < 30; i++) {
      if (await js('__live.requests===2')) break;
      await wait(50);
    }
    await js("document.dispatchEvent(new Event('pet-stop-live-voice'))");
    await wait(300);
    report.cancelled = await js(
      "__live.tracks.every(track=>track.readyState==='ended')&&__live.peers.every(peer=>peer.connectionState==='closed')",
    );
    assert.equal(report.cancelled, true);
    await js('__ctx.close()');
    const memoryFile = path.join(run, 'home/dsh-pet/memory.json');
    report.memoryUntouched = !fs.existsSync(memoryFile) || fs.readFileSync(memoryFile, 'utf8').trim() === '{}';
    assert.equal(report.memoryUntouched, true);
    await js("document.querySelector('[data-tab=config]').click()");
    for (let i = 0; i < 100; i++) {
      if (await js("!!document.querySelector('#model') && !!document.querySelector('#g-voice-name button')")) break;
      await wait(100);
    }
    await js(
      "(()=>{document.querySelector('#model').dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#save').click();})()",
    );
    for (let i = 0; i < 100; i++) {
      if (await js("document.querySelector('#status').dataset.ok==='true' && document.querySelector('#dirty').hidden"))
        break;
      await wait(100);
    }
    report.savedClearedDirty = await js(
      "document.querySelector('#status').dataset.ok==='true' && document.querySelector('#dirty').hidden",
    );
    assert.equal(report.savedClearedDirty, true);
    chat.close();
    await wait(200);
    report.savedClosed = chat.isDestroyed();
    assert.equal(report.savedClosed, true);
    app.emit('codex-bigfish:chat', 'config');
    for (let i = 0; i < 100; i++) {
      chat = RealWindow.getAllWindows().find((win) => win.getTitle() === '桌宠设置');
      if (chat) break;
      await wait(100);
    }
    for (let i = 0; i < 100; i++) {
      if (await js("!!document.querySelector('#g-voice-name button')")) break;
      await wait(100);
    }
    await js(
      "document.querySelector('#g-voice-name button').click();[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes('糖芽')).click()",
    );
    closeChoice = 0;
    chat.close();
    await wait(200);
    report.cancelCloseKeptWindow = !chat.isDestroyed();
    assert.equal(report.cancelCloseKeptWindow, true);
    closeChoice = 1;
    chat.close();
    await wait(200);
    report.discardClosed = chat.isDestroyed();
    assert.equal(report.discardClosed, true);
    assert.ok(RealWindow.getAllWindows().every((win) => !win.isVisible()));
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error.stack;
  } finally {
    clearTimeout(guard);
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
    setTimeout(() => app.exit(report.ok ? 0 : 1), 1000).unref();
    app.quit();
  }
})();
