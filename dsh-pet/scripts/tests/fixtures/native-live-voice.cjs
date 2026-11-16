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
let evidenceJs;
report.nativeCalls = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith('https://chatgpt.com/backend-api/wham/realtime/calls') && typeof init?.body === 'string') {
    const value = JSON.parse(init.body);
    report.nativeCalls.push({
      voice: value.session?.audio?.output?.voice,
      model: value.session?.model,
      hasStyle: value.session?.instructions?.includes('【声音与节奏】') === true,
      hasLongMemory: value.session?.instructions?.includes('记忆测试星') === true,
    });
  }
  return originalFetch(url, init);
};
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
}, 150000);
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
      body: JSON.stringify({
        text:
          process.env.DSH_PET_ACTION_PROBE === '1'
            ? '你吃个西瓜给我看。'
            : process.env.DSH_PET_MEMORY_PROBE === '1'
              ? '我喜欢喝咖啡。'
              : '测试。',
        voice: 'windows/zh-CN',
      }),
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
    assert.match(
      dictation.text,
      process.env.DSH_PET_ACTION_PROBE === '1'
        ? /西瓜/
        : process.env.DSH_PET_MEMORY_PROBE === '1'
          ? /我喜欢.*咖啡/
          : /测试/,
    );
    report.dictation = dictation.text;
    if (process.env.DSH_PET_NATIVE_WORKBUDDY === '1') {
      const selected = await (
        await fetch(origin + '/standalone-ai/settings', {
          method: 'POST',
          headers,
          body: JSON.stringify({ protocol: 'workbuddy', model: 'deepseek-v4-flash', timeoutMs: 60000 }),
        })
      ).json();
      assert.equal(selected.protocol, 'workbuddy');
      report.workbuddyModel = selected.model;
      const checked = await (
        await fetch(origin + '/standalone-ai/test', {
          method: 'POST',
          headers,
          body: JSON.stringify({ protocol: 'workbuddy', model: 'deepseek-v4-flash' }),
        })
      ).json();
      assert.equal(checked.ok, true, checked.message);
      assert.match(checked.reply, /连接成功/);
      assert.equal(checked.modelUsed, 'deepseek-v4-flash');
      report.workbuddyConnected = true;
      // 本文件独立验收 Codex 原生通道；WorkBuddy 连续语音由专门的离屏用例验收。
      await fetch(origin + '/standalone-ai/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocol: 'codex', model: 'gpt-6-luna' }),
      });
    }
    const remembered = await (
      await fetch(origin + '/dsh-pet-7340/chat/long-term-memory?pet=main', {
        method: 'POST',
        headers,
        body: JSON.stringify(
          process.env.DSH_PET_MEMORY_PROBE === '1'
            ? { text: '用户喜欢记忆测试星', kind: 'preference' }
            : { text: '用户希望被称为「记忆测试星」', kind: 'profile' },
        ),
      })
    ).json();
    assert.equal(remembered.ok, true);
    app.emit('codex-bigfish:chat');
    let chat;
    for (let i = 0; i < 100; i++) {
      chat = RealWindow.getAllWindows().find((win) => win.getTitle() === '桌宠设置');
      if (chat) break;
      await wait(100);
    }
    assert.ok(chat);
    const js = (source) => chat.webContents.executeJavaScript(source, true);
    evidenceJs = js;
    const awaitStartup = async () => {
      for (let i = 0; i < 150; i++) {
        await wait(100);
        if (
          i >= 50 &&
          (await js(
            '!__live.currentAssistantTurnId||__live.finalTexts.some(turn=>turn.id===__live.currentAssistantTurnId)',
          ))
        )
          break;
      }
    };

    const waitCompleteSpeech = async () => {
      if (process.env.DSH_PET_MEMORY_PROBE !== '1') return;
      const target = await js('__live.currentAssistantTurnId');
      for (let i = 0; i < 250; i++) {
        if (
          await js(
            `(()=>{const turn=__live.finalTexts.find(turn=>turn.id===${JSON.stringify(target)});if(!turn?.text)return false;const norm=text=>String(text||'').replace(/[^\\p{L}\\p{N}]/gu,'');const requests=__live.customRequests.filter(row=>row.turnId===turn.id);return requests.length>0&&requests.every(row=>row.readyAt&&!row.aborted&&!row.failed)&&norm(requests.map(row=>row.text).join(''))===norm(turn.text);})()`,
          )
        )
          return;
        await wait(100);
      }
      throw new Error('Completed turn did not reach synthesis without missing or repeated text');
    };

    for (let i = 0; i < 100; i++) {
      if (await js("!!document.querySelector('.pet-chat-live-button')")) break;
      await wait(100);
    }
    report.hasButton = await js("!!document.querySelector('.pet-chat-live-button')");
    assert.equal(report.hasButton, true);
    report.stylePicker = await js(
      "({value:document.querySelector('.pet-chat-live-tone select').value,choices:[...document.querySelectorAll('.pet-chat-live-tone option')].map(option=>option.value),modes:[...document.querySelectorAll('.pet-chat-live-mode option')].map(option=>option.value),streaming:MediaSource.isTypeSupported('audio/mpeg')})",
    );
    assert.equal(report.stylePicker.value, 'starbell');
    assert.equal(report.stylePicker.choices.length, 4);
    assert.ok(report.stylePicker.choices.includes('dango'));
    assert.deepEqual(report.stylePicker.modes, ['natural', 'custom']);
    assert.equal(report.stylePicker.streaming, true);
    await js(`(async()=>{
      window.__live={tracks:[],peers:[],played:0,requests:0,blobs:[],inputs:0,turns:0,assistantCreated:0,customRequests:[],customPlayed:[],customAudios:[],voiceSamples:{},metrics:[],assistantDoneAt:[],utterances:[],warmRequests:[],finalTexts:[],wire:[]};
      document.addEventListener('pet-custom-voice-play',event=>{const row=__live.currentUtterance;const now=performance.now();__live.metrics.push({...event.detail,...(row?{fromSpeechEndMs:Math.round(now-row.endAt),recognitionMs:row.recognizedAt===undefined?undefined:Math.round(row.recognizedAt-row.endAt),modelToFirstTextMs:row.recognizedAt===undefined?undefined:Math.round(now-event.detail.fromTextMs-row.recognizedAt)}:{})});});
      const originalFetch=window.fetch;window.fetch=async(url,init)=>{
        const voice=(String(url).endsWith('/voice/speak')||String(url).endsWith('/voice/stream'))?JSON.parse(init?.body||'{}').voice:undefined;
        const warm=String(url).endsWith('/voice/warm')?{active:JSON.parse(init?.body||'{}').active,at:performance.now()}:undefined;if(warm)__live.warmRequests.push(warm);
        const queuedAt=performance.now();const response=await originalFetch(url,init);
        if(warm)void response.clone().json().then(value=>Object.assign(warm,{status:response.status,prepared:value.prepared,reason:value.reason})).catch(()=>{});
        if(voice){const row={voice,turnId:__live.currentAssistantTurnId,text:JSON.parse(init.body).text,queuedAt,headersAt:performance.now(),path:String(url),type:response.headers.get('content-type')};__live.customRequests.push(row);void response.clone().arrayBuffer().then(bytes=>{Object.assign(row,{readyAt:performance.now(),bytes:bytes.byteLength,aborted:init?.signal?.aborted===true});if(row.type?.includes('audio')&&!__live.voiceSamples[voice]){let binary='';for(const value of new Uint8Array(bytes))binary+=String.fromCharCode(value);__live.voiceSamples[voice]=btoa(binary);}}).catch(()=>{row.aborted=init?.signal?.aborted===true;row.failed=true;});}
        return response;
      };
      const buffer=Uint8Array.from(atob(${JSON.stringify(b64)}),c=>c.charCodeAt(0));
      window.__ctx=new AudioContext();const decoded=await __ctx.decodeAudioData(buffer.buffer);const pcm=decoded.getChannelData(0);let first=0,last=pcm.length-1;while(first<last&&Math.abs(pcm[first])<0.005)first++;while(last>first&&Math.abs(pcm[last])<0.005)last--;first=Math.max(0,first-Math.round(decoded.sampleRate*0.02));last=Math.min(pcm.length-1,last+Math.round(decoded.sampleRate*0.02));window.__sample=__ctx.createBuffer(1,last-first+1,decoded.sampleRate);__sample.copyToChannel(pcm.slice(first,last+1),0);
      navigator.mediaDevices.getUserMedia=async()=>{
        __live.requests++;__live.currentAssistantTurnId=undefined;__live.currentInput=undefined;__live.currentUtterance=undefined;window.__out=__ctx.createMediaStreamDestination();__live.tracks.push(...__out.stream.getTracks());return __out.stream;
      };
      window.__speakLiveSample=async()=>{const source=__ctx.createBufferSource();source.buffer=__sample;source.connect(__out);await __ctx.resume();const row={startAt:performance.now(),endAt:performance.now()+__sample.duration*1000};__live.utterances.push(row);source.start();};
      const RealPeer=RTCPeerConnection;window.RTCPeerConnection=new Proxy(RealPeer,{construct(target,args){
        const peer=new target(...args);__live.peers.push(peer);
        const createChannel=peer.createDataChannel.bind(peer);peer.createDataChannel=(...args)=>{const channel=createChannel(...args);channel.addEventListener('message',event=>{const value=JSON.parse(event.data);if(['turn.created','turn.done','turn.delta','input_transcript.added','output_transcript.added'].includes(value.type))__live.wire.push(value);if(value.type==='input_transcript.added'){__live.inputs++;__live.currentInput=__live.utterances[__live.utterances.length-1];if(__live.currentInput)__live.currentInput.recognizedAt??=performance.now();}if(value.type==='turn.created'&&value.turn.role==='assistant'){__live.assistantCreated++;__live.currentAssistantTurnId=value.turn.id;__live.currentUtterance=__live.currentInput;}if(value.type==='turn.done'&&value.turn.role==='assistant'){__live.turns++;__live.finalTexts.push({id:value.turn.id,text:value.turn.transcript});__live.assistantDoneAt.push(performance.now());}});return channel;};
        peer.addEventListener('track',event=>{
          const stream=event.streams[0]||new MediaStream([event.track]);window.__recorder=new MediaRecorder(stream);
          __recorder.ondataavailable=event=>{if(event.data.size)__live.blobs.push(event.data);};__recorder.start(500);
        });return peer;
      }});
      const originalPlay=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){this.volume=0;return originalPlay.call(this).then(()=>{if(this.srcObject)__live.played++;if(this.dataset.petCustomVoice){__live.customAudios.push(this);__live.customPlayed.push(this.dataset.petCustomVoice);const row=__live.customRequests.find(row=>row.voice===this.dataset.petCustomVoice&&!row.playingAt&&!row.aborted);if(row)row.playingAt=performance.now();}});};
      const input=document.querySelector('textarea.pet-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'保留这条草稿');input.dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('.pet-chat-live-button').click();
    })()`);
    for (let i = 0; i < 400; i++) {
      const status = await js(
        "({button:document.querySelector('.pet-chat-live-button').textContent,status:document.querySelector('.pet-chat-live-status')?.textContent,connected:window.__live.peers[0]?.connectionState})",
      );
      if (status.connected === 'connected' && status.button === '结束语音') break;
      if (status.button === '语音聊天' && status.status) throw Error(status.status);
      await wait(100);
    }
    report.connected = await js("__live.peers[0]?.connectionState==='connected'");
    assert.equal(report.connected, true);
    await awaitStartup();
    await js('__speakLiveSample()');
    for (let i = 0; i < 180; i++) {
      if (
        await js(
          "__live.metrics.some(row=>row.voice==='bigfish-cute/starbell-v1'&&Number.isFinite(row.fromSpeechEndMs))",
        )
      )
        break;
      const failed = await js(
        "document.querySelector('.pet-chat-live-button').textContent==='语音聊天' ? document.querySelector('.pet-chat-live-status')?.textContent : ''",
      );
      if (failed) throw new Error(failed);
      await wait(100);
    }
    assert.equal(await js("document.querySelector('audio[data-pet-native-voice]').volume"), 0);
    if (process.env.DSH_PET_ACTION_PROBE === '1')
      report.presentation = await require('./voice-presentation.cjs')({
        windows: () => RealWindow.getAllWindows(),
        origin,
        headers,
        run,
      });
    await js('window.__oldCustom=__live.customAudios.slice();__live.interruptedTurnId=__live.currentAssistantTurnId');
    await js('__speakLiveSample()');
    await wait(350);
    report.bargeInStoppedOld = await js('__oldCustom.every(audio=>audio.paused)');
    assert.equal(report.bargeInStoppedOld, true);
    for (let i = 0; i < 180; i++) {
      if (
        await js(
          "__live.inputs>=2 && __live.metrics.filter(row=>row.voice==='bigfish-cute/starbell-v1'&&Number.isFinite(row.fromSpeechEndMs)).length>=2",
        )
      )
        break;
      await wait(100);
    }
    if (process.env.DSH_PET_MEMORY_PROBE === '1') {
      for (let i = 0; i < 200; i++) {
        if (await js('__live.turns>=2')) break;
        await wait(100);
      }
    }
    await waitCompleteSpeech();
    await wait(1500);
    report.live = await js(`(async()=>{
      if(window.__recorder?.state!=='inactive')await new Promise(done=>{__recorder.onstop=done;__recorder.stop();});
      const bytes=await new Blob(__live.blobs).arrayBuffer();const recordedBytes=bytes.byteLength;let peak=0;
      if(bytes.byteLength){
        const decoded=await new OfflineAudioContext(1,1,48000).decodeAudioData(bytes);const pcm=decoded.getChannelData(0);for(const value of pcm)peak=Math.max(peak,Math.abs(value));
        const wav=new ArrayBuffer(44+pcm.length*2);const view=new DataView(wav);const tag=(offset,value)=>{for(let i=0;i<value.length;i++)view.setUint8(offset+i,value.charCodeAt(i));};
        tag(0,'RIFF');view.setUint32(4,36+pcm.length*2,true);tag(8,'WAVEfmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,decoded.sampleRate,true);view.setUint32(28,decoded.sampleRate*2,true);view.setUint16(32,2,true);view.setUint16(34,16,true);tag(36,'data');view.setUint32(40,pcm.length*2,true);
        for(let i=0;i<pcm.length;i++)view.setInt16(44+i*2,Math.round(Math.max(-1,Math.min(1,pcm[i]))*32767),true);
        let binary='';for(const value of new Uint8Array(wav))binary+=String.fromCharCode(value);window.__nativeVoicePreview=btoa(binary);
      }
      return {user:document.querySelector('.pet-chat-live-user')?.textContent,pet:document.querySelector('.pet-chat-live-pet')?.textContent,played:__live.played,recordedBytes,peak,inputs:__live.inputs,turns:__live.turns,assistantCreated:__live.assistantCreated,requests:__live.requests,draft:document.querySelector('textarea.pet-chat-input').value,microphoneDisabled:document.querySelector('.pet-chat-mic').disabled};
    })()`);
    assert.match(
      report.live.user,
      process.env.DSH_PET_ACTION_PROBE === '1' ? /西瓜/ : process.env.DSH_PET_MEMORY_PROBE === '1' ? /咖啡/ : /测试/,
    );
    assert.ok(report.live.pet);
    assert.ok(report.live.played > 0);
    assert.ok(report.live.peak > 0.001);
    assert.ok(report.live.inputs >= 2 && report.live.assistantCreated >= 2);
    fs.writeFileSync(
      path.join(run, 'native-sweet-voice.wav'),
      Buffer.from(await js('window.__nativeVoicePreview'), 'base64'),
    );
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
    await js(
      "(()=>{const select=document.querySelector('.pet-chat-live-tone select');select.value='sugarbud';select.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await wait(100);
    await js("document.querySelector('.pet-chat-live-button').click()");
    for (let i = 0; i < 250; i++) {
      if (await js("__live.peers[1]?.connectionState==='connected'")) break;
      await wait(100);
    }
    await awaitStartup();
    await js('__speakLiveSample()');
    for (let i = 0; i < 300; i++) {
      if (
        await js(
          "__live.metrics.some(row=>row.voice==='bigfish-cute/sugarbud-v1'&&Number.isFinite(row.fromSpeechEndMs))",
        )
      )
        break;
      await wait(100);
    }
    assert.equal(await js("__live.customPlayed.includes('bigfish-cute/sugarbud-v1')"), true);
    for (let i = 0; i < 100; i++) {
      if (await js("!!__live.voiceSamples['bigfish-cute/sugarbud-v1']")) break;
      await wait(100);
    }
    if (process.env.DSH_PET_MEMORY_PROBE === '1') {
      for (let i = 0; i < 200; i++) {
        if (await js('__live.turns>=3')) break;
        await wait(100);
      }
    }
    await waitCompleteSpeech();
    await js("document.querySelector('.pet-chat-live-button').click()");
    await wait(300);
    await js(
      "(()=>{const select=document.querySelector('.pet-chat-live-tone select');select.value='dango';select.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await wait(100);
    await js("document.querySelector('.pet-chat-live-button').click()");
    for (let i = 0; i < 250; i++) {
      if (await js("__live.peers[2]?.connectionState==='connected'")) break;
      await wait(100);
    }
    await awaitStartup();
    await js('__speakLiveSample()');
    for (let i = 0; i < 300; i++) {
      if (
        await js("__live.metrics.some(row=>row.voice==='bigfish-cute/dango-v1'&&Number.isFinite(row.fromSpeechEndMs))")
      )
        break;
      await wait(100);
    }
    assert.equal(await js("__live.customPlayed.includes('bigfish-cute/dango-v1')"), true);
    for (let i = 0; i < 100; i++) {
      if (await js("['starbell-v1','sugarbud-v1','dango-v1'].every(id=>__live.voiceSamples['bigfish-cute/'+id])"))
        break;
      await wait(100);
    }
    if (process.env.DSH_PET_MEMORY_PROBE === '1') {
      for (let i = 0; i < 200; i++) {
        if (await js('__live.turns>=4')) break;
        await wait(100);
      }
    }
    await waitCompleteSpeech();
    if (process.env.DSH_PET_MEMORY_PROBE === '1') await wait(1200);
    report.custom = await js(
      '({requests:__live.customRequests,played:__live.customPlayed,metrics:__live.metrics,assistantDoneAt:__live.assistantDoneAt,wire:__live.wire,warmRequests:__live.warmRequests,interruptedTurnId:__live.interruptedTurnId,finalTexts:__live.finalTexts})',
    );
    if (process.env.DSH_PET_MEMORY_PROBE === '1') {
      let matched = 0;
      const normalized = (text) => String(text || '').replace(/[^\p{L}\p{N}]/gu, '');
      for (const turn of report.custom.finalTexts) {
        if (turn.id === report.custom.interruptedTurnId) continue;
        const requests = report.custom.requests.filter((row) => row.turnId === turn.id);
        if (!requests.length || requests.some((row) => row.aborted || row.failed) || !turn.text) continue;
        assert.equal(
          normalized(requests.map((row) => row.text).join('')),
          normalized(turn.text),
          'Actual TTS input must match the completed assistant transcript without duplicated words',
        );
        matched++;
      }
      report.actualSpeechTextMatches = matched;
      assert.ok(matched >= 3, 'Three complete custom-voice turns must match TTS input');
    }
    assert.ok(
      report.custom.requests.every((request) => request.aborted || request.type.includes('audio')),
      '未取消的音色请求必须成功返回真实音频',
    );
    for (const id of ['starbell-v1', 'sugarbud-v1', 'dango-v1']) {
      const voice = 'bigfish-cute/' + id;
      const b64 = await js('__live.voiceSamples[' + JSON.stringify(voice) + ']');
      assert.ok(b64);
      fs.writeFileSync(path.join(run, id + '.mp3'), Buffer.from(b64, 'base64'));
    }
    await js("document.dispatchEvent(new Event('pet-stop-live-voice'))");
    await wait(300);
    report.cancelled = await js(
      "__live.tracks.every(track=>track.readyState==='ended')&&__live.peers.every(peer=>peer.connectionState==='closed')",
    );
    assert.equal(report.cancelled, true);
    await js(
      "(()=>{const mode=document.querySelector('.pet-chat-live-mode select');mode.value='natural';mode.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await wait(100);
    assert.equal(await js("!!document.querySelector('.pet-chat-live-tone')"), false);
    const customCount = await js('__live.customRequests.length');
    await js("document.querySelector('.pet-chat-live-button').click()");
    for (let i = 0; i < 250; i++) {
      if (await js("__live.peers[3]?.connectionState==='connected'")) break;
      await wait(100);
    }
    await awaitStartup();
    await js('__speakLiveSample()');
    for (let i = 0; i < 180; i++) {
      if (await js("!!document.querySelector('.pet-chat-live-pet')?.textContent")) break;
      await wait(100);
    }
    report.nativeDirect = await js(
      "__live.peers[3]?.connectionState==='connected' && !!document.querySelector('.pet-chat-live-pet')?.textContent && __live.customRequests.length===" +
        customCount,
    );
    assert.equal(report.nativeDirect, true);
    await js("document.querySelector('.pet-chat-live-button').click()");
    await wait(300);
    await js(
      "(()=>{const mode=document.querySelector('.pet-chat-live-mode select');mode.value='custom';mode.dispatchEvent(new Event('change',{bubbles:true}));})()",
    );
    await wait(100);
    report.rememberedTone = await js("document.querySelector('.pet-chat-live-tone select')?.value");
    assert.equal(report.rememberedTone, 'dango');
    assert.equal(report.nativeCalls[0]?.voice, undefined);
    assert.equal(report.nativeCalls[0]?.hasStyle, true);
    assert.equal(report.nativeCalls[1]?.hasStyle, true);
    await js('__ctx.close()');
    const memoryFile = path.join(run, 'home/dsh-pet/memory.json');
    report.memoryUntouched = !fs.existsSync(memoryFile) || fs.readFileSync(memoryFile, 'utf8').trim() === '{}';
    assert.equal(report.memoryUntouched, true);
    if (process.env.DSH_PET_MEMORY_PROBE === '1') {
      const memory = await (await fetch(origin + '/dsh-pet-7340/chat/long-term-memory?pet=main', { headers })).json();
      report.voiceMemoryCaptured = memory.facts.some(
        (row) => row.source === 'codex-voice' && row.kind === 'preference' && row.text.includes('咖啡'),
      );
      assert.equal(report.voiceMemoryCaptured, true, 'Final spoken user preference must reach durable memory');
    }
    if (process.env.DSH_PET_NATIVE_WORKBUDDY === '1') {
      await fetch(origin + '/standalone-ai/settings', {
        method: 'POST',
        headers,
        body: JSON.stringify({ protocol: 'workbuddy', model: 'deepseek-v4-flash' }),
      });
      await js(
        "(()=>{const input=document.querySelector('textarea.pet-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'请用一句简短中文告诉我你准备好聊天了，句中包含连接成功四个字。');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
      );
      await wait(100);
      await js("document.querySelector('.pet-chat-send').click()");
      for (let i = 0; i < 500; i++) {
        if (
          await js(
            "[...document.querySelectorAll('.pet-chat-msg.is-pet .pet-chat-bubble')].some(item=>item.textContent.includes('连接成功'))",
          )
        )
          break;
        await wait(100);
      }
      report.workbuddyChat = await js(
        "[...document.querySelectorAll('.pet-chat-msg.is-pet .pet-chat-bubble')].some(item=>item.textContent.includes('连接成功'))",
      );
      assert.equal(report.workbuddyChat, true, 'WorkBuddy must answer through the actual pet chat panel');
      // 协议由测试通过本地接口改回 WorkBuddy；重载以读取新的已保存设置。
      await new Promise((done) => {
        chat.webContents.once('did-finish-load', done);
        chat.webContents.reload();
      });
      for (let i = 0; i < 100; i++) {
        if (await js("!!document.querySelector('.pet-chat-live-button')")) break;
        await wait(100);
      }
    }
    await js("document.querySelector('[data-tab=config]').click()");
    for (let i = 0; i < 100; i++) {
      if (await js("!!document.querySelector('#model') && !!document.querySelector('#g-voice-name button')")) break;
      await wait(100);
    }
    if (process.env.DSH_PET_NATIVE_WORKBUDDY === '1') {
      chat.setSize(390, 844);
      await js(
        "document.querySelector('#model').scrollIntoView({block:'center'});document.querySelector('#model-toggle').click()",
      );
      for (let i = 0; i < 120; i++) {
        if (
          await js(
            "[...document.querySelectorAll('[role=option]')].some(item=>item.textContent.includes('deepseek-v4-flash'))",
          )
        )
          break;
        await wait(100);
      }
      assert.equal(await js("document.querySelector('#workbuddy-note').hidden"), false);
      assert.equal(await js("document.querySelector('#apiKey').closest('.field').hidden"), true);
      report.workbuddySmallScreen = await js(
        "document.documentElement.scrollWidth<=innerWidth && [...document.querySelectorAll('.selectMenu')].every(menu=>{const r=menu.getBoundingClientRect();return r.left>=0 && r.right<=innerWidth})",
      );
      assert.equal(report.workbuddySmallScreen, true);
      fs.writeFileSync(
        path.join(run, 'workbuddy-settings-offscreen.png'),
        (await chat.webContents.capturePage()).toPNG(),
      );
      await js(
        "[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes('deepseek-v4-flash')).click()",
      );
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
    try {
      report.custom = await evidenceJs?.(
        '({requests:window.__live?.customRequests,played:window.__live?.customPlayed,metrics:window.__live?.metrics,assistantDoneAt:window.__live?.assistantDoneAt,wire:window.__live?.wire,finalTexts:window.__live?.finalTexts})',
      );
      for (const id of ['starbell-v1', 'sugarbud-v1', 'dango-v1']) {
        const b64 = await evidenceJs?.('window.__live?.voiceSamples[' + JSON.stringify('bigfish-cute/' + id) + ']');
        if (b64) fs.writeFileSync(path.join(run, id + '.mp3'), Buffer.from(b64, 'base64'));
      }
    } catch {
      /* 窗口已关闭时仍保留其他诊断。 */
    }
  } finally {
    clearTimeout(guard);
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(report, null, 2));
    setTimeout(() => app.exit(report.ok ? 0 : 1), 1000).unref();
    app.quit();
  }
})();
