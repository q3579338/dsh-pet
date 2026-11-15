/** 连续音频帧累计开口时长，过滤单帧点击声；静音后允许下一次开口打断。 */
export function microphoneSpeechGate(onSpeech: () => void): (rms: number, milliseconds: number) => void {
  let active = 0;
  let silence = 0;
  let speaking = false;
  return (rms, milliseconds) => {
    if (rms > 0.012) {
      active += milliseconds;
      silence = 0;
      if (active >= 64 && !speaking) {
        speaking = true;
        onSpeech();
      }
    } else {
      silence += milliseconds;
      active = Math.max(0, active - milliseconds / 2);
      if (silence >= 220) {
        speaking = false;
        active = 0;
      }
    }
  };
}

/** 复用录音入口已验证的音频处理链，输出逐帧置零，不播放麦克风内容。 */
export function watchMicrophoneSpeech(stream: MediaStream, onSpeech: () => void): () => void {
  const context = new AudioContext();
  const source = context.createMediaStreamSource(stream);
  const processor = context.createScriptProcessor(1024, 1, 1);
  const feed = microphoneSpeechGate(onSpeech);
  processor.onaudioprocess = (event) => {
    const values = event.inputBuffer.getChannelData(0);
    let energy = 0;
    for (const value of values) energy += value * value;
    event.outputBuffer.getChannelData(0).fill(0);
    feed(Math.sqrt(energy / values.length), (values.length / context.sampleRate) * 1000);
  };
  source.connect(processor);
  processor.connect(context.destination);
  void context.resume().catch(() => {});
  return () => {
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    void context.close().catch(() => {});
  };
}
