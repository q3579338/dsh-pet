/** 音色试听：使用当前草稿合成音频，换音色或重绘面板时释放请求与播放资源。 */
export function voicePreviewScript(): string {
  return `
let activeVoicePreview = null;

function stopVoicePreview() {
  const active = activeVoicePreview;
  activeVoicePreview = null;
  if (!active) return;
  clearTimeout(active.timer);
  active.controller.abort();
  active.audio.pause();
  active.audio.removeAttribute('src');
  active.audio.load();
  active.audio.hidden = true;
  if (active.url) URL.revokeObjectURL(active.url);
  active.button.disabled = false;
  setStatus(active.status, '');
}

function voicePreviewControls() {
  const status = make('p', { id: 'g-voice-preview-status', class: 'fieldHint', role: 'status', 'aria-live': 'polite' });
  const audio = make('audio', { id: 'g-voice-preview-audio', controls: true, preload: 'none', hidden: true, class: 'voicePreviewAudio' });
  audio.controls = true;
  const play = button('试听当前音色', async () => {
    stopVoicePreview();
    const current = { controller: new AbortController(), audio, button: play, status, url: '', timer: null };
    activeVoicePreview = current;
    play.disabled = true;
    setStatus(status, '正在生成试听…');
    current.timer = setTimeout(() => current.controller.abort(), 30000);
    try {
      const response = await fetch(API + '/voice/speak', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: current.controller.signal,
        headers: { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ voice: state.globals.voiceName, text: '我来啦！今天也想陪着你，把小小的事情都变得开心一点。' }),
      });
      if (!response.ok) throw new Error(response.status === 403 ? '打开凭据已失效，请重新打开设置。' : '音色合成失败，请检查网络后重试。');
      const clip = await response.blob();
      if (!clip.size) throw new Error('没有生成音频，请重试。');
      if (activeVoicePreview !== current) return;
      clearTimeout(current.timer);
      current.url = URL.createObjectURL(clip);
      audio.src = current.url;
      audio.volume = clampNumber(state.globals.voiceVolume, 0, 1, 1);
      audio.hidden = false;
      try {
        await audio.play();
        if (activeVoicePreview === current) setStatus(status, '正在试听。点「保存」后将此音色用于回复。', 'ok');
      } catch {
        if (activeVoicePreview === current) setStatus(status, '试听已生成，点击播放器播放；点「保存」后生效。', 'ok');
      }
    } catch (error) {
      if (activeVoicePreview !== current) return;
      setStatus(status, current.controller.signal.aborted ? '试听超时，请稍后重试。' : error.message, 'error');
    } finally {
      clearTimeout(current.timer);
      if (activeVoicePreview === current) play.disabled = false;
    }
  });
  play.id = 'g-voice-preview';
  return make('div', { class: 'field' }, [play, audio, status]);
}
`;
}
