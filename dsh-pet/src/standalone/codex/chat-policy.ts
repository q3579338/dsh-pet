/** 只选账号实际可用的模型与思考等级；陪伴线程的工具配置只在本线程内关闭。 */
import { codexRecord } from './client.ts';
import { CodexFailure } from './errors.ts';

/** 模型目录里陪伴对话需要的字段。 */
export interface ChatModel {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly effort: string;
}

/** 校验模型和思考等级，不把隐藏模型或不完整条目当成可选项。 */
export function parseChatModels(entries: readonly unknown[]): ChatModel[] {
  const models: ChatModel[] = [];
  for (const entry of entries) {
    const model = codexRecord(entry);
    const id = typeof model.model === 'string' ? model.model : model.id;
    if (model.hidden === true || typeof id !== 'string' || !id) continue;
    const efforts = (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : [])
      .map((item) => codexRecord(item).reasoningEffort)
      .filter((item): item is string => typeof item === 'string');
    const preferred = typeof model.defaultReasoningEffort === 'string' ? model.defaultReasoningEffort : '';
    const effort = efforts.includes('low') ? 'low' : efforts.includes(preferred) ? preferred : efforts[0];
    if (!effort || models.some((candidate) => candidate.id === id)) continue;
    models.push({
      id,
      name: typeof model.displayName === 'string' ? model.displayName : id,
      isDefault: model.isDefault === true,
      effort,
    });
  }
  return models;
}

/** 默认跟随服务声明；用户明确选过的型号不可用时明确报错，不偷偷换型号。 */
export function selectChatModel(models: readonly ChatModel[], selected: string): ChatModel {
  const model =
    selected === 'default'
      ? (models.find((entry) => entry.isDefault) ?? models[0])
      : models.find((entry) => entry.id === selected);
  if (!model) throw new CodexFailure('当前账号没有可用的所选模型，请重新拉取模型列表后选择。');
  return model;
}

/** 不让普通陪伴消息触发文件、插件或外部操作；不改用户的 Codex 全局设置。 */
export function companionThreadConfig(raw: unknown): Record<string, unknown> {
  const config = codexRecord(raw);
  const mcpServers = codexRecord(config.mcp_servers);
  return {
    'features.shell_tool': false,
    'features.plugins': false,
    'features.remote_plugin': false,
    'features.multi_agent': false,
    'features.apps': false,
    'features.code_mode': false,
    'features.memories': false,
    web_search: 'disabled',
    project_doc_max_bytes: 0,
    notify: [],
    hooks: {},
    include_apps_instructions: false,
    ...Object.fromEntries(Object.keys(mcpServers).map((name) => [`mcp_servers.${name}.enabled`, false])),
  };
}
