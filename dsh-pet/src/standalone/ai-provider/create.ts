/**
 * 独立 AI 服务的装配根：初始化设置存储、维护就绪与暂停状态，把生成通道与连接测试接到门面上。
 *
 * 不解析请求（归 ./request）、不定义限额（归 ./limits）、不写通道细节（归 ./stream 与 ./test-connection）。
 * 必须始终成立：设置读不安全时整体失败，不顺势启用环境里的旧凭据。
 * @module dsh-pet/src/standalone/ai-provider/create
 */
import { type StandaloneLogger } from '../context.ts';
import { createAiConfig, type StandaloneAiPublicSettings } from '../ai-config.ts';
import type { AiRuntime, AiStore, StandaloneAiDependencies, StandaloneAiService } from './types.ts';
import { PROVIDER } from './limits.ts';
import { discoverModels } from './list-models.ts';
import { queryStandaloneBalance } from './balance.ts';
import { createTextStream } from './stream.ts';
import { testAiConnection } from './test-connection.ts';
import { codexChatWorkspace, discoverCodexModels } from '../codex/transport.ts';
import { createCodexChatConnection } from '../codex/chat-connection.ts';
import { codexRecord } from '../codex/client.ts';
import { selectChatModel } from '../codex/chat-policy.ts';
import { CodexFailure } from '../codex/errors.ts';
import { startCodexMonitor } from '../codex/monitor.ts';
import type { CodexEventSink } from '../codex/events.ts';
import { codexImageUrl } from '../codex/attachments.ts';
import { createCodexAccountReader } from '../codex/account.ts';
import type { BalanceResult } from '../../host/balance/types.ts';
import { createWorkBuddyConnection } from '../workbuddy/connection.ts';
import { WorkBuddyFailure } from '../workbuddy/executable.ts';
import { workBuddyVoiceStream } from './voice.ts';
import { workBuddyAccountBalance } from '../workbuddy/account.ts';

/**
 * 保存设置：单飞、先中止在途请求，失败即暂停，等下一次保存成功才恢复。
 * @throws 服务已释放、另一次保存正在进行，或存储层校验/落盘失败时。
 */
async function saveSettings(runtime: AiRuntime, store: AiStore, input: unknown): Promise<StandaloneAiPublicSettings> {
  if (runtime.disposed) throw new Error('Standalone AI is disposed.');
  if (runtime.saving) throw new Error('Standalone AI settings are being saved.');
  runtime.saving = true;
  // 保存期间先中止在途请求，避免旧设置继续产生输出。
  runtime.active?.abort();
  try {
    const result = await store.save(input);
    if (!runtime.disposed) runtime.paused = false;
    return result;
  } catch (error) {
    runtime.paused = true;
    throw error;
  } finally {
    runtime.saving = false;
  }
}

/**
 * 创建独立模式 AI 服务。
 * @param home - DSH_HOME。
 * @param logger - 日志出口。
 * @param dependencies - 测试注入的传输与时钟。
 * @returns AI 服务。
 * @throws 设置无法安全读取时抛出。
 */
export function createStandaloneAi(
  home: string,
  logger: StandaloneLogger,
  dependencies: StandaloneAiDependencies = {},
): StandaloneAiService {
  let store: AiStore;
  try {
    store = createAiConfig(home);
  } catch {
    logger.error('Cannot securely load standalone AI settings.');
    // 持久化损坏或权限不安全时不能顺势启用环境里的旧凭据，宁可整体失败。
    throw new Error('Cannot securely load standalone AI settings.');
  }
  const runtime: AiRuntime = {
    workbuddy: dependencies.workbuddy ?? createWorkBuddyConnection(home),
    codexConnection: createCodexChatConnection(codexChatWorkspace(home)),
    imageUrl: (ref) => codexImageUrl(home, ref),
    store,
    logger,
    fetcher: dependencies.fetch ?? globalThis.fetch.bind(globalThis),
    disposed: false,
    paused: false,
    saving: false,
    active: undefined,
    ready(): boolean {
      return (
        !runtime.disposed &&
        !runtime.paused &&
        !runtime.saving &&
        !!store.current().model &&
        (['codex', 'workbuddy'].includes(store.current().protocol) ||
          (!!store.current().baseUrl && !!store.current().apiKey))
      );
    },
  };
  const listeners = new Set<CodexEventSink>();
  runtime.codexEvents = (event) => {
    for (const listener of listeners) listener(event);
  };
  const stopMonitor =
    process.env.DSH_PET_CODEX === '1' && process.env.DSH_PET_CODEX_OBSERVE !== '0'
      ? startCodexMonitor((event) => {
          if (store.current().protocol === 'codex') runtime.codexEvents?.(event);
        })
      : () => {};
  const modelOf = (): string => store.current().model;
  const accountReader = dependencies.codexAccount ?? createCodexAccountReader(home);
  const readCodexBalance = async (): Promise<BalanceResult> => {
    const result = await accountReader.read();
    return runtime.disposed || store.current().protocol !== 'codex'
      ? { ok: false, provider: 'codex', reason: 'unsupported', message: 'Codex 账户连接已关闭或切换。' }
      : result;
  };
  const readWorkBuddyBalance = async (): Promise<BalanceResult> => {
    try {
      if (!runtime.workbuddy?.balance)
        return { ok: false, provider: 'workbuddy', reason: 'unsupported', message: 'WorkBuddy 套餐查询组件暂不可用。' };
      return workBuddyAccountBalance(await runtime.workbuddy.balance());
    } catch (error) {
      return {
        ok: false,
        provider: 'workbuddy',
        reason: 'fetch-error',
        message: error instanceof WorkBuddyFailure ? error.message : 'WorkBuddy 套餐查询失败，请检查登录和网络。',
      };
    }
  };

  return {
    onSessionEvent(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    currentSelection: () => ({ provider: PROVIDER, model: runtime.ready() ? modelOf() : '' }),
    codexVoiceModel: () => (store.current().protocol === 'codex' ? modelOf() : 'default'),
    voiceSelection: () => ({ protocol: store.current().protocol, model: modelOf() }),
    voiceStream: (model, request, signal) => workBuddyVoiceStream(runtime, model, request, signal),
    prepareVoice: async (active) => {
      if (active && (!runtime.ready() || store.current().protocol !== 'workbuddy'))
        throw new WorkBuddyFailure('请先选择 WorkBuddy 模型。');
      await runtime.workbuddy?.prepareVoice?.(active);
    },
    listProviders: () => (runtime.ready() ? [{ id: PROVIDER, name: 'Standalone AI' }] : []),
    listModels: async (provider) =>
      runtime.ready() && provider === PROVIDER ? [{ id: modelOf(), name: modelOf() }] : [],
    resolveModelInfo: async (provider = PROVIDER, model = modelOf(), signal) =>
      runtime.ready() && !signal?.aborted && provider === PROVIDER && model === modelOf()
        ? { id: model, name: model }
        : undefined,
    stream: createTextStream(runtime),
    getSettings: () => store.publicSettings(),
    saveSettings: (input) => saveSettings(runtime, store, input),
    isReady: () => runtime.ready(),
    balanceAuth: () =>
      store.current().protocol === 'codex'
        ? { provider: 'codex', apiKey: '', query: readCodexBalance }
        : store.current().protocol === 'workbuddy'
          ? {
              provider: 'workbuddy',
              apiKey: '',
              query: async () => {
                const result = await readWorkBuddyBalance();
                return runtime.disposed || store.current().protocol !== 'workbuddy'
                  ? { ok: false, provider: 'workbuddy', reason: 'unsupported', message: 'WorkBuddy 连接已关闭或切换。' }
                  : result;
              },
            }
          : { provider: store.current().balanceProvider, apiKey: store.current().apiKey },
    deepseekKey: () => store.current().deepseekApiKey,
    async testConnection(input) {
      if (runtime.disposed) return { ok: false, message: '服务已关闭' };
      if ((input.protocol ?? store.current().protocol) === 'workbuddy') {
        try {
          const { reply, modelUsed } = await runtime.workbuddy!.test(
            input.model || (store.current().protocol === 'workbuddy' ? modelOf() : 'deepseek-v4-flash'),
          );
          return {
            ok: true,
            message:
              '国内版 WorkBuddy 内置模型已实际回复' + (modelUsed ? '（服务端模型：' + modelUsed + '）' : '') + '。',
            reply,
            modelUsed,
          };
        } catch (error) {
          return {
            ok: false,
            message: error instanceof WorkBuddyFailure ? error.message : '无法连接国内版 WorkBuddy，请检查登录和模型。',
          };
        }
      }
      if ((input.protocol ?? store.current().protocol) !== 'codex')
        return testAiConnection(runtime.fetcher, store.current(), input);
      try {
        const connection = runtime.codexConnection!;
        const client = await connection.open();
        const [models, auth] = await Promise.all([
          connection.models(),
          client.request('account/read', { refreshToken: false }),
        ]);
        if (!codexRecord(auth).account) throw new CodexFailure('请先在 Codex 中登录，再测试连接。');
        selectChatModel(models, input.model || store.current().model);
        return { ok: true, message: `已连接本机 Codex，读取到 ${models.length} 个可用模型；本次检查未请求聊天回复。` };
      } catch (error) {
        return {
          ok: false,
          message: error instanceof CodexFailure ? error.message : '无法连接本机 Codex。请检查程序路径与登录状态。',
        };
      }
    },
    async discoverModels(input) {
      if (runtime.disposed) return { ok: false, code: 'input', message: '服务已关闭' };
      if ((input.protocol ?? store.current().protocol) === 'workbuddy') {
        try {
          return { ok: true, models: await runtime.workbuddy!.models() };
        } catch (error) {
          return {
            ok: false,
            code: 'workbuddy-unavailable',
            message: error instanceof WorkBuddyFailure ? error.message : '无法读取国内版 WorkBuddy 模型。',
          };
        }
      }
      if ((input.protocol ?? store.current().protocol) !== 'codex')
        return discoverModels(runtime.fetcher, store.current(), input);
      try {
        return { ok: true, models: await discoverCodexModels(runtime.codexConnection) };
      } catch {
        return {
          ok: false,
          code: 'codex-unavailable',
          message: '无法读取本机 Codex 的模型列表，请检查程序与登录状态。',
        };
      }
    },
    queryBalance: async (input = {}) => {
      const protocol = input.protocol ?? store.current().protocol;
      if (runtime.disposed)
        return { ok: false, provider: protocol, reason: 'unsupported', message: '账户连接已关闭。' };
      if (protocol === 'codex') return accountReader.read();
      if (protocol === 'workbuddy') return readWorkBuddyBalance();
      if (protocol !== store.current().protocol)
        return {
          ok: false,
          provider: protocol,
          reason: 'unsupported',
          message: '请先保存当前来源的连接，再查询对应余额。',
        };
      return queryStandaloneBalance(store.current().balanceProvider, store.current().apiKey);
    },
    dispose() {
      runtime.disposed = true;
      runtime.active?.abort();
      accountReader.dispose();
      runtime.codexConnection?.dispose();
      runtime.workbuddy?.dispose();
      stopMonitor();
      listeners.clear();
    },
  };
}
