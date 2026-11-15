/** 每个桌宠服务持有自己的聊天连接和短期模型目录，空闲、断线、关闭时统一释放。 */
import { CodexClient, codexRecord } from './client.ts';
import { parseChatModels, type ChatModel } from './chat-policy.ts';
import { CodexFailure } from './errors.ts';

/** 聊天与模型选择共享连接；账户额度仍使用独立的只读连接。 */
export interface CodexChatConnection {
  open(): Promise<CodexClient>;
  models(): Promise<readonly ChatModel[]>;
  reset(): void;
  dispose(): void;
}

/** 停止后不可复用；初始化与目录拉取各自单飞，不会自动重发失败的聊天。 */
export function createCodexChatConnection(
  workspace: string,
  createClient = () => new CodexClient(workspace),
): CodexChatConnection {
  let client: CodexClient | undefined;
  let connecting: Promise<CodexClient> | undefined;
  let catalog: { expires: number; models: readonly ChatModel[] } | undefined;
  let listing: Promise<readonly ChatModel[]> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const reset = (): void => {
    clearTimeout(idle);
    catalog = undefined;
    const previous = client;
    client = undefined;
    previous?.close();
  };
  const touch = (): void => {
    clearTimeout(idle);
    idle = setTimeout(reset, 5 * 60_000);
    idle.unref();
  };
  const open = async (): Promise<CodexClient> => {
    if (disposed) throw new CodexFailure('Codex 聊天服务已关闭。');
    touch();
    if (connecting) return connecting;
    if (client?.isAlive()) return client;
    if (!connecting) {
      const next = createClient();
      client = next;
      next.onNotification(({ method }) => {
        if (method === 'account/updated') catalog = undefined;
      });
      next.onClose(() => {
        if (client === next) {
          client = undefined;
          catalog = undefined;
        }
      });
      connecting = next
        .initialize()
        .then(() => {
          if (disposed || !next.isAlive()) throw new CodexFailure('Codex 连接已关闭，请重试。');
          return next;
        })
        .catch((error: unknown) => {
          next.close();
          throw error;
        })
        .finally(() => {
          connecting = undefined;
        });
    }
    return connecting;
  };
  return {
    open,
    async models() {
      const current = await open();
      if (catalog && catalog.expires > Date.now()) return catalog.models;
      if (!listing)
        listing = (async () => {
          const entries: unknown[] = [];
          let cursor: string | undefined;
          for (let page = 0; page < 10; page++) {
            const result = codexRecord(
              await current.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) }),
            );
            entries.push(...(Array.isArray(result.data) ? result.data : []));
            cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
            if (!cursor) break;
          }
          const models = parseChatModels(entries);
          if (!models.length) throw new CodexFailure('Codex 没有返回可用模型，请检查登录状态或更新 Codex。');
          if (client === current && current.isAlive()) catalog = { expires: Date.now() + 60_000, models };
          return models;
        })().finally(() => {
          listing = undefined;
        });
      return listing;
    },
    reset,
    dispose() {
      disposed = true;
      reset();
    },
  };
}
