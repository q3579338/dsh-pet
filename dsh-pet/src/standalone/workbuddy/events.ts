/** WorkBuddy 独立进程只返回模型目录、正文和固定失败类别，身份不进入这条管道。 */
import type { DiscoveredModel } from '../ai-provider/types.ts';
import { WorkBuddyFailure } from './executable.ts';
/** 不透传运行组件或上游的任意错误正文。 */
export function workBuddyError(code: unknown): WorkBuddyFailure {
  const messages: Record<string, string> = {
    auth: 'WorkBuddy 登录已失效或不可读，请在国内版 WorkBuddy 中重新登录后重试。',
    region: '当前登录不属于国内版 WorkBuddy，请检查账号区域。',
    unsupported: '当前 WorkBuddy 版本的登录组件暂不兼容，请检查版本。',
    model: '所选 WorkBuddy 模型不可用，请重新读取目录并选择。',
    quota: 'WorkBuddy 额度不足或暂时限流，请在 WorkBuddy 中查看后重试。',
    input: 'WorkBuddy 请求内容无效，请重新发送。',
  };
  return new WorkBuddyFailure(
    typeof code === 'string' && messages[code] ? messages[code] : 'WorkBuddy 未能回复，请检查登录、模型和网络。',
  );
}
/** 模型标识也会进入请求头，只接受可见的受限字符。 */
export function validWorkBuddyModel(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u.test(id) && !id.startsWith('custom');
}
/** 运行组件的目录同样按白名单解析，不接收 URL、凭据或其它配置字段。 */
export function parseWorkBuddyModels(value: unknown): DiscoveredModel[] {
  if (!Array.isArray(value)) throw new WorkBuddyFailure('无法读取 WorkBuddy 内置模型目录。');
  const seen = new Set<string>(),
    models: DiscoveredModel[] = [];
  for (const raw of value.slice(0, 500)) {
    if (!raw || typeof raw !== 'object' || !('id' in raw) || !validWorkBuddyModel(raw.id) || seen.has(raw.id)) continue;
    seen.add(raw.id);
    models.push({ id: raw.id, name: 'name' in raw && typeof raw.name === 'string' ? raw.name.slice(0, 150) : raw.id });
  }
  if (!models.length) throw new WorkBuddyFailure('WorkBuddy 没有返回可用的内置模型，请检查登录。');
  return models;
}
/** 每个请求拥有独立完成状态；中途断连不能计为成功。 */
export function workBuddyEvents(): {
  accept(line: string): { text?: string; modelUsed?: string; models?: DiscoveredModel[] };
  finish(): void;
} {
  let done = false,
    chars = 0;
  return {
    accept(line) {
      if (!line.trim()) return {};
      if (line.length > 1024 * 1024) throw new WorkBuddyFailure('WorkBuddy 返回内容过大，已停止。');
      let v: Record<string, unknown>;
      try {
        const raw: unknown = JSON.parse(line);
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Error();
        v = raw as Record<string, unknown>;
      } catch {
        throw new WorkBuddyFailure('WorkBuddy 返回格式无法识别。');
      }
      if (done) throw new WorkBuddyFailure('WorkBuddy 返回了重复完成事件。');
      if (v.type === 'error') throw workBuddyError(v.code);
      if (v.type === 'done') {
        done = true;
        return {};
      }
      if (v.type === 'models') return { models: parseWorkBuddyModels(v.models) };
      if (v.type === 'model' && validWorkBuddyModel(v.model)) return { modelUsed: v.model };
      if (v.type === 'text' && typeof v.text === 'string') {
        chars += v.text.length;
        if (chars > 16384) throw new WorkBuddyFailure('WorkBuddy 回复过长，已停止。');
        return { text: v.text };
      }
      throw new WorkBuddyFailure('WorkBuddy 返回了无法识别的事件。');
    },
    finish() {
      if (!done) throw new WorkBuddyFailure('WorkBuddy 未完整结束回复，请重试。');
    },
  };
}
