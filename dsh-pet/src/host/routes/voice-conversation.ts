/** 连续 WorkBuddy 语音的本地路由，沿用宿主访问鉴权与请求体上限。 */
import type { PetRouteDeps, RouteInput } from './types.ts';
import type { RouteResult } from '../http.ts';
import { failResult, invalidJson, methodNotAllowed, okResult } from './result.ts';

/** 不认识的路径交回原生语音路由。 */
export async function handleConversationRoutes(
  deps: PetRouteDeps,
  input: RouteInput,
): Promise<RouteResult | undefined> {
  if (!input.rest.startsWith('voice/conversation/')) return undefined;
  const service = deps.voiceConversation,
    action = input.rest.slice('voice/conversation/'.length);
  if (!service) return failResult('unsupported', '当前模式没有启用 WorkBuddy 连续语音。');
  if (action === 'options') return input.method === 'GET' ? okResult(service.options()) : methodNotAllowed();
  if (action === 'events') {
    if (input.method !== 'GET') return methodNotAllowed();
    const id = input.url.searchParams.get('sessionId');
    if (!id || !/^[\w-]{1,80}$/u.test(id) || !service.touch(id)) return failResult('bad-request', '语音会话已结束。');
    return {
      kind: 'stream',
      contentType: 'application/x-ndjson',
      stream: service.events(id, input.signal),
      dispose: () => service.stop(id),
    };
  }
  if (!['start', 'audio', 'end', 'interrupt', 'touch', 'stop'].includes(action))
    return failResult('bad-request', '未知的语音操作。');
  if (input.method !== 'POST') return methodNotAllowed();
  let value: Record<string, unknown>;
  try {
    const parsed = JSON.parse(input.body ?? 'null');
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      return failResult('bad-request', '语音参数无效。');
    value = parsed;
  } catch {
    return invalidJson();
  }
  if (action === 'start') {
    if (typeof value.petId !== 'string' || value.petId.length > 200 || typeof value.styleId !== 'string')
      return failResult('bad-request', '缺少桌宠或音色。');
    return okResult(await service.start(value.petId, value.styleId, input.signal));
  }
  if (typeof value.sessionId !== 'string' || !/^[\w-]{1,80}$/u.test(value.sessionId))
    return failResult('bad-request', '语音会话编号无效。');
  try {
    const id = value.sessionId;
    if (action === 'stop') service.stop(id);
    if (action === 'touch') return okResult({ ok: service.touch(id) });
    if (action === 'interrupt') service.interrupt(id);
    if (action === 'end') service.end(id, value.utterance as number);
    if (action === 'audio') {
      if (typeof value.audio !== 'string') return failResult('bad-request', '语音片段无效。');
      await service.audio(id, value.utterance as number, value.sequence as number, value.audio);
    }
    return okResult({ ok: true });
  } catch {
    return failResult('bad-request', '语音片段未能送达，请结束后重新开始。');
  }
}
