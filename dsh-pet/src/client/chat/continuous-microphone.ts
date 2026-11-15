/** 连续语音的本地分句：保留开头、短暂停顿合并，约320毫秒安静后立即结束当前听写。 */
import { floatToPcm16, HEAR_SAMPLE_RATE } from '../../shared/hear.ts';

/** 分句不依赖浏览器，便于检查开头、尾音与长句上限。 */
export function createSpeechSegmenter(callbacks: {
  begin(): void;
  chunk(pcm: Uint8Array): void;
  end(): void;
}): (values: Float32Array) => void {
  let speaking = false,
    loud = 0,
    quiet = 0,
    elapsed = 0;
  let prefix: Float32Array[] = [];
  const chunk = (samples: Float32Array): void => {
    const pcm = floatToPcm16(samples);
    const bytes = new Uint8Array(pcm.length * 2),
      view = new DataView(bytes.buffer);
    for (let i = 0; i < pcm.length; i++) view.setInt16(i * 2, pcm[i], true);
    callbacks.chunk(bytes);
  };
  return (values) => {
    let energy = 0;
    for (const value of values) energy += value * value;
    const rms = Math.sqrt(energy / Math.max(1, values.length)),
      ms = (values.length / HEAR_SAMPLE_RATE) * 1000;
    if (!speaking) {
      prefix.push(new Float32Array(values));
      while (prefix.length > 4) prefix.shift();
      loud = rms >= 0.012 ? loud + ms : 0;
      if (loud < 96) return;
      speaking = true;
      quiet = 0;
      elapsed = 0;
      callbacks.begin();
      for (const samples of prefix) {
        chunk(samples);
        elapsed += (samples.length / HEAR_SAMPLE_RATE) * 1000;
      }
      prefix = [];
      return;
    }
    chunk(values);
    elapsed += ms;
    quiet = rms < 0.008 ? quiet + ms : 0;
    if (quiet >= 320 || elapsed >= 28000) {
      speaking = false;
      loud = 0;
      quiet = 0;
      prefix = [];
      callbacks.end();
    }
  };
}

/** 共用一条已有麦克风流，处理器输出始终置零，避免回放录音。 */
export async function captureContinuousSpeech(
  stream: MediaStream,
  callbacks: Parameters<typeof createSpeechSegmenter>[0],
): Promise<() => void> {
  const context = new AudioContext({ sampleRate: HEAR_SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream),
    processor = context.createScriptProcessor(1024, 1, 1);
  const feed = createSpeechSegmenter(callbacks);
  processor.onaudioprocess = (event) => {
    event.outputBuffer.getChannelData(0).fill(0);
    feed(event.inputBuffer.getChannelData(0));
  };
  source.connect(processor);
  processor.connect(context.destination);
  try {
    await context.resume();
  } catch {
    source.disconnect();
    processor.disconnect();
    await context.close();
    throw new Error('麦克风无法启动。');
  }
  return () => {
    processor.onaudioprocess = null;
    source.disconnect();
    processor.disconnect();
    void context.close().catch(() => {});
  };
}
