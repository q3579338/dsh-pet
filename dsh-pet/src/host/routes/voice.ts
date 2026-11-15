/**
 * 语音领域：`/voice/speak` 合成、`/voice/hear` 识别与 `/voice/voices` 音色列表。
 *
 * 校验、排队与缓存都在语音服务里；这里只判定方法与 JSON，并把结论映射成路由应答。
 * 契约见 openapi.yaml，本模块不重复描述字段。
 * @module dsh-pet/src/host/routes/voice
 */
import type { RouteResult } from '../http.ts';
import type { PetRouteDeps, RouteInput } from './types.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

/** 语音领域：未命中返回 undefined，命中返回应答。 */
export async function handleVoiceRoutes(deps: PetRouteDeps, input: RouteInput): Promise<RouteResult | undefined> {
  const { body, method, rest, signal } = input;

  if (rest === 'voice/live/start' || rest === 'voice/live/touch' || rest === 'voice/live/stop') {
    if (method !== 'POST') return methodNotAllowed();
    if (!deps.liveVoice) return failResult('unsupported', '当前模式未启用 Codex 即时语音。');
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return failResult('bad-request', '语音参数无效。');
    const value = parsed as Record<string, unknown>;
    if (rest === 'voice/live/start') {
      if (typeof value.petId !== 'string' || typeof value.sdp !== 'string')
        return failResult('bad-request', '缺少桌宠或连接参数。');
      if (value.styleId !== undefined && typeof value.styleId !== 'string')
        return failResult('bad-request', '即时语音风格无效。');
      return okResult(await deps.liveVoice.start(value.petId, value.sdp, signal, value.styleId as string | undefined));
    }
    if (typeof value.sessionId !== 'string' || !/^[\w-]{1,200}$/u.test(value.sessionId))
      return failResult('bad-request', '语音会话编号无效。');
    if (rest === 'voice/live/touch') return okResult({ ok: deps.liveVoice.touch(value.sessionId) });
    await deps.liveVoice.stop(value.sessionId);
    return okResult({ ok: true });
  }

  if (rest === 'voice/voices') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult({ ok: true, ...deps.voice.list() });
  }

  if (rest === 'voice/speak' || rest === 'voice/stream') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const result =
      rest === 'voice/stream' && deps.voice.stream
        ? await deps.voice.stream(parsed, signal)
        : await deps.voice.speak(parsed, signal);
    if (!result.ok) return failResult(result.reason, result.message);
    if ('stream' in result)
      return { kind: 'stream', stream: result.stream, contentType: result.contentType, dispose: result.dispose };
    return { kind: 'file', file: result.file, contentType: result.contentType };
  }

  // 识别实现的候选来源：与 /voice/hear 的 provider 字段同源，前端据此渲染下拉。
  if (rest === 'voice/hear-providers') {
    if (method !== 'GET') return methodNotAllowed();
    return okResult({ ok: true, ...deps.speech.list() });
  }

  // 与 /voice/speak 反向：音频进、文字出。格式由宿主 provider 校验，这里只转发结论。
  if (rest === 'voice/hear') {
    if (method !== 'POST') return methodNotAllowed();
    let parsed: unknown;
    try {
      parsed = JSON.parse(body ?? 'null');
    } catch {
      return invalidJson();
    }
    const result = await deps.speech.hear(parsed, signal);
    if (!result.ok) return failResult(result.reason, result.message);
    return okResult({ ok: true, text: result.text });
  }

  return undefined;
}
