/** 把 Codex 的协议错误收敛成固定中文说明，避免返回请求正文、地址或凭据。 */

/** 只有这一类经过脱敏的说明可以穿过通用 AI 错误边界。 */
export class CodexFailure extends Error {}

/** 外部错误原文仅用于分类，不进入可展示的错误对象或日志。 */
export function codexFailure(raw: unknown): CodexFailure {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const text = typeof value.message === 'string' ? value.message : '';
  if (/unauthori|not logged|authentication|login required|401|invalid.*token/i.test(text))
    return new CodexFailure('Codex 登录已失效，请在 Codex 中重新登录后再试。');
  if (/rate.?limit|quota|usage limit|credits|429/i.test(text))
    return new CodexFailure('Codex 当前额度不足或请求过多，请查看额度和重置时间。');
  if (/model.*(?:not|unavail|support)|unsupported.*model|reasoning.*effort/i.test(text))
    return new CodexFailure('当前账号不支持所选模型或思考等级，请重新拉取模型列表后选择。');
  if (/network|connect|timed? ?out|proxy|dns|stream.*disconnect/i.test(text))
    return new CodexFailure('Codex 网络连接失败，请检查当前网络或代理后重试。');
  return new CodexFailure('Codex 未能完成请求，请检查登录、额度与模型后重试。');
}
