/** 原生端到端夹具：全部窗口强制离屏、禁用显示与焦点，只使用明确的合成麦克风音频。 */
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const electron = require('electron');
const { app, session } = electron;
const runDir = process.env.FISH_TEST_RUN,
  root = process.env.FISH_TEST_ROOT;
const RealWindow = electron.BrowserWindow;
const report = { offscreen: true, shown: false, responses: [], errors: [] };
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
Module._load = function (name, ...args) {
  return name === 'electron' ? wrapped : originalLoad.call(this, name, ...args);
};
app.commandLine.appendSwitch('user-data-dir', path.join(runDir, 'electron'));
app.commandLine.appendSwitch('mute-audio');
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', path.join(runDir, 'sample.wav'));
const wait = (ms) => new Promise((done) => setTimeout(done, ms));
const guard = setTimeout(() => {
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ ...report, error: 'deadline' }, null, 2));
  app.exit(1);
}, 60000);
(async () => {
  try {
    console.info('native-check: loading packaged app');
    await import(pathToFileURL(path.join(process.env.DSH_PET_NATIVE_COMPANION_ASAR, 'lib/app.js')).href);
    await app.whenReady();
    for (let i = 0; i < 100 && !RealWindow.getAllWindows().length; i++) await wait(100);
    const win = RealWindow.getAllWindows()[0];
    if (!win) throw Error('No offscreen window');
    const runtime = JSON.parse(fs.readFileSync(path.join(runDir, 'home/dsh-pet/standalone-runtime.json')));
    const origin = 'http://127.0.0.1:' + runtime.port;
    report.configuredVoice = JSON.parse(fs.readFileSync(path.join(runDir, 'home/dsh-pet/main-config.jsonc'))).voiceName;
    assert.equal(report.configuredVoice, 'edge/zh-CN-XiaoyiNeural');
    const sample = await fetch(origin + '/dsh-pet-7340/voice/speak', {
      method: 'POST',
      headers: { 'X-DSH-Pet-Token': runtime.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '你好，今天的天气很好。', voice: 'windows/zh-CN' }),
    });
    assert.equal(sample.status, 200);
    console.info('native-check: local recognition sample generated');
    fs.writeFileSync(path.join(runDir, 'sample.wav'), Buffer.from(await sample.arrayBuffer()));
    const catalog = await (
      await fetch(origin + '/dsh-pet-7340/voice/voices', {
        headers: { 'X-DSH-Pet-Token': runtime.token },
      })
    ).json();
    const cute = catalog.providers.find((provider) => provider.id === 'bigfish-cute');
    assert.equal(cute?.voices.length, 4);
    report.voicePreviews = [];
    fs.mkdirSync(path.join(runDir, 'voice-previews'));
    for (const voice of [{ id: 'edge/zh-CN-XiaoyiNeural', name: '晓伊（原版默认）' }, ...cute.voices]) {
      console.info('native-check: synthesizing ' + voice.id);
      const response = await fetch(origin + '/dsh-pet-7340/voice/speak', {
        method: 'POST',
        headers: { 'X-DSH-Pet-Token': runtime.token, 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: voice.id, text: '我来啦！今天也想陪着你，把小小的事情都变得开心一点。' }),
      });
      assert.equal(response.status, 200, 'Synthesis failed for ' + voice.id);
      assert.match(response.headers.get('content-type'), /audio\/mpeg/);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.ok(bytes.length > 1000);
      const file = voice.id.replace('/', '-') + '.mp3';
      fs.writeFileSync(path.join(runDir, 'voice-previews', file), bytes);
      report.voicePreviews.push({
        id: voice.id,
        name: voice.name,
        bytes: bytes.length,
        file,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
      console.info('native-check: audio generated ' + voice.id);
    }
    const javascript = (source) => win.webContents.executeJavaScript(source);
    win.webContents.on('console-message', (_event, level, text) => {
      if (level >= 2) report.errors.push(text.slice(0, 300));
    });
    session.defaultSession.webRequest.onCompleted((details) => {
      if (details.url.startsWith(origin))
        report.responses.push({ path: new URL(details.url).pathname, status: details.statusCode });
    });
    for (let i = 0; i < 70; i++) {
      if (await javascript('Boolean(window.__dshPetDebug?.spriteCount)')) break;
      await wait(100);
    }
    report.loaded = await javascript(
      '({debug:window.__dshPetDebug,secure:window.isSecureContext,media:!!navigator.mediaDevices})',
    );
    report.context = await javascript(
      `(()=>{document.querySelector('.pet-hit')?.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:400,clientY:300}));return {menu:window.__dshPetDebug?.menuOpen};})()`,
    );
    report.open = await javascript(
      `(()=>{const el=[...document.querySelectorAll('*')].find(x=>x.children.length===0&&x.textContent==='对话');el?.click();return {found:!!el,chat:window.__dshPetDebug?.chatOpen,inputs:[...document.querySelectorAll('textarea')].map(x=>({class:x.className,rect:{x:x.getBoundingClientRect().x,y:x.getBoundingClientRect().y,width:x.getBoundingClientRect().width,height:x.getBoundingClientRect().height}}))};})()`,
    );
    for (let i = 0; i < 80 && RealWindow.getAllWindows().length < 2; i++) await wait(100);
    const chat = RealWindow.getAllWindows().find((item) => item !== win);
    assert.ok(chat, 'Native chat window must open from original pet menu');
    const chatJs = (source) => chat.webContents.executeJavaScript(source, true);
    for (let i = 0; i < 100; i++) {
      if (
        await chatJs(
          "Boolean(document.querySelector('textarea.pet-chat-input') && document.querySelector('.pet-chat-tab'))",
        )
      )
        break;
      await wait(100);
    }
    report.chatReady = await chatJs(
      "({input:!!document.querySelector('textarea.pet-chat-input'),microphone:!!document.querySelector('.pet-chat-mic'),errors:[...document.querySelectorAll('.pet-chat-error')].map(x=>x.textContent)})",
    );
    assert.equal(report.chatReady.input, true);
    assert.equal(report.chatReady.microphone, true);
    assert.deepEqual(report.chatReady.errors, []);
    await chatJs('document.fonts.ready.then(() => true)');
    const microphoneBounds = () =>
      chatJs(
        "(()=>{const rect=document.querySelector('.pet-chat-mic').getBoundingClientRect();return {x:rect.x,y:rect.y,width:rect.width,height:rect.height};})()",
      );
    const idleBounds = {};
    for (const width of [680, 400]) {
      chat.setSize(width, 800);
      await wait(100);
      idleBounds[width] = await microphoneBounds();
    }
    report.microphoneStability = [];
    const checkMicrophoneBounds = async (state) => {
      for (const width of [680, 400]) {
        chat.setSize(width, 800);
        await wait(100);
        const bounds = await microphoneBounds();
        report.microphoneStability.push({ state, width, idle: idleBounds[width], bounds });
        for (const field of ['x', 'y', 'width', 'height'])
          assert.ok(
            Math.abs(bounds[field] - idleBounds[width][field]) <= 0.5,
            `Microphone ${field} moved during ${state} at ${width}px`,
          );
      }
    };
    await javascript(
      "document.querySelector('.pet-hit').dispatchEvent(new MouseEvent('dblclick',{bubbles:true,cancelable:true}))",
    );
    await wait(200);
    assert.equal(RealWindow.getAllWindows().length, 2);
    report.doubleClickReusesWindow = true;
    await chatJs(
      `(()=>{const original=navigator.mediaDevices.getUserMedia;window.__restoreMic=()=>{navigator.mediaDevices.getUserMedia=original;};navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('denied','NotAllowedError');};document.querySelector('.pet-chat-mic').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:8,bubbles:true,cancelable:true}));})()`,
    );
    await wait(150);
    report.microphoneDeniedFeedback = await chatJs("document.querySelector('.pet-chat-hear-hint').textContent");
    assert.match(report.microphoneDeniedFeedback, /麦克风未获授权/);
    await checkMicrophoneBounds('denied');
    await chatJs(
      "document.querySelector('.pet-chat-mic').dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:8,bubbles:true}));window.__restoreMic();",
    );
    await javascript(
      "(()=>{window.__petPlayed=0;const original=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){const audio=this.tagName==='AUDIO';return original.call(this).then(()=>{if(audio)window.__petPlayed++;});};})()",
    );
    await chatJs(
      "document.querySelector('.pet-chat-mic').dispatchEvent(new PointerEvent('pointerdown',{button:0,pointerId:7,bubbles:true,cancelable:true}))",
    );
    await wait(200);
    await checkMicrophoneBounds('recording');
    await wait(3600);
    await chatJs(
      "document.querySelector('.pet-chat-mic').dispatchEvent(new PointerEvent('pointerup',{button:0,pointerId:7,bubbles:true,cancelable:true}))",
    );
    for (let i = 0; i < 120; i++) {
      if (await chatJs("document.querySelector('textarea.pet-chat-input').value.includes('天气')")) break;
      await wait(100);
    }
    report.transcript = await chatJs("document.querySelector('textarea.pet-chat-input').value");
    assert.match(report.transcript, /天气/);
    await checkMicrophoneBounds('recognized');
    await chatJs(
      "(()=>{const input=document.querySelector('textarea.pet-chat-input');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(input,'连接测试，请只回复：我收到你的消息了。');input.dispatchEvent(new Event('input',{bubbles:true}));})()",
    );
    await wait(100);
    await chatJs("document.querySelector('.pet-chat-send').click()");
    for (let i = 0; i < 300; i++) {
      if (await chatJs("Boolean(document.querySelector('.pet-chat-speak'))")) break;
      await wait(100);
    }
    report.reply = await chatJs(
      "({speaker:!!document.querySelector('.pet-chat-speak'),error:document.querySelector('.pet-chat-error')?.textContent,hasReply:document.body.innerText.includes('我收到你的消息了')})",
    );
    assert.equal(report.reply.speaker, true);
    assert.equal(report.reply.hasReply, true);
    for (let i = 0; i < 80; i++) {
      if (await javascript('window.__petPlayed>0')) break;
      await wait(100);
    }
    report.automaticReplyPlayback = await javascript('window.__petPlayed');
    assert.ok(report.automaticReplyPlayback > 0);
    await chatJs(
      "(()=>{window.__nativePlayed=0;window.__nativePlayError='';const original=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){return original.call(this).then(()=>{window.__nativePlayed++;}).catch(error=>{window.__nativePlayError=error.name;throw error;});};document.querySelector('.pet-chat-speak').click();})()",
    );
    for (let i = 0; i < 80; i++) {
      if (await chatJs('window.__nativePlayed>0 || !!window.__nativePlayError')) break;
      await wait(100);
    }
    report.playback = await chatJs('({played:window.__nativePlayed,error:window.__nativePlayError})');
    assert.ok(report.playback.played > 0);
    assert.equal(report.playback.error, '');
    fs.writeFileSync(path.join(runDir, 'chat-offscreen.png'), (await chat.webContents.capturePage()).toPNG());
    app.emit('codex-bigfish:chat', 'config');
    for (let i = 0; i < 80; i++) {
      if (
        await chatJs(
          "Boolean(document.querySelector('#balance-btn') && !document.querySelector('#balance-btn').disabled && !document.querySelector('#panel-config').hidden)",
        )
      )
        break;
      await wait(100);
    }
    await chatJs("document.querySelector('#balance-btn').click()");
    for (let i = 0; i < 150; i++) {
      if (await chatJs("document.querySelector('#balance-result')?.dataset.ok === 'true'")) break;
      await wait(100);
    }
    report.nativeQuotaRead = await chatJs("document.querySelector('#balance-result')?.dataset.ok === 'true'");
    assert.equal(report.nativeQuotaRead, true);
    await chatJs(
      "(()=>{window.__previewPlayed=0;window.__previewPlayError='';const original=HTMLMediaElement.prototype.play;HTMLMediaElement.prototype.play=function(){const audio=this.tagName==='AUDIO';return original.call(this).then(()=>{if(audio)window.__previewPlayed++;}).catch(error=>{window.__previewPlayError=error.name;throw error;});};})()",
    );
    await chatJs("document.querySelector('#g-voice-name button').click()");
    const voiceChoices = await chatJs("[...document.querySelectorAll('[role=option]')].map(item=>item.textContent)");
    for (const name of ['晓伊', '星铃', '月棉', '糖芽', '团子'])
      assert.ok(voiceChoices.some((choice) => choice.includes(name)));
    const playedBeforePreview = await chatJs('window.__previewPlayed');
    await chatJs(
      "[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes('糖芽')).click();document.querySelector('#g-voice-preview').scrollIntoView({block:'center'});document.querySelector('#g-voice-preview').click()",
    );
    for (let i = 0; i < 150; i++) {
      if (await chatJs("document.querySelector('#g-voice-preview-status').dataset.ok === 'true'")) break;
      await wait(100);
    }
    report.settingsPreview = {
      choices: voiceChoices,
      played: (await chatJs('window.__previewPlayed')) > playedBeforePreview,
      player: await chatJs(
        "(()=>{const audio=document.querySelector('#g-voice-preview-audio');return {status:document.querySelector('#g-voice-preview-status').textContent,hidden:audio.hidden,readyState:audio.readyState,error:audio.error?.message,playError:window.__previewPlayError};})()",
      ),
      draftOnly:
        JSON.parse(fs.readFileSync(path.join(runDir, 'home/dsh-pet/main-config.jsonc'))).voiceName ===
        report.configuredVoice,
    };
    if (!report.settingsPreview.played) {
      await chatJs("document.querySelector('#g-voice-preview-audio').play()");
      report.settingsPreview.played = (await chatJs('window.__previewPlayed')) > playedBeforePreview;
    }
    assert.equal(report.settingsPreview.played, true);
    fs.writeFileSync(path.join(runDir, 'voice-preview-offscreen.png'), (await chat.webContents.capturePage()).toPNG());
    await chatJs(
      "document.querySelector('#g-voice-name button').click();[...document.querySelectorAll('[role=option]')].find(item=>item.textContent.includes('晓伊')).click()",
    );
    report.settingsPreview.stoppedOnChange = await chatJs(
      "document.querySelector('#g-voice-preview-audio').paused && !document.querySelector('#g-voice-preview-audio').hasAttribute('src')",
    );
    await chatJs("document.querySelector('#pet-save').click()");
    for (let i = 0; i < 80; i++) {
      if (
        await chatJs(
          "document.querySelector('#pet-status').dataset.ok === 'true' && document.querySelector('#dirty').hidden",
        )
      )
        break;
      await wait(100);
    }
    report.settingsPreview.savedOriginal =
      JSON.parse(fs.readFileSync(path.join(runDir, 'home/dsh-pet/main-config.jsonc'))).voiceName ===
      'edge/zh-CN-XiaoyiNeural';
    assert.equal(report.settingsPreview.savedOriginal, true);
    if (RealWindow.getAllWindows().some((item) => item.isVisible())) throw Error('A test window became visible');
    report.ok = true;
  } catch (error) {
    report.ok = false;
    report.error = error.stack;
  } finally {
    clearTimeout(guard);
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(report, null, 2));
    process.exitCode = report.ok ? 0 : 1;
    const forcedExit = setTimeout(() => app.exit(report.ok ? 0 : 1), 1500);
    forcedExit.unref();
    app.quit();
  }
})();
