/** 原生对话窗口：普通可输入窗口承载既有聊天页，显示由用户的聊天入口触发。 */

/** 窗口控制只使用这些 Electron 能力，测试可在无桌面环境替换。 */
export interface CompanionWindow {
  isDestroyed(): boolean;
  showInactive(): void;
  focus(): void;
  loadURL(url: string): Promise<void>;
  once(event: 'ready-to-show' | 'closed', callback: () => void): void;
}

/** 聊天与设置共用一个普通窗口，重复打开保留聊天草稿。 */
export function createCompanionWindow(deps: {
  create: (options: Record<string, unknown>) => CompanionWindow;
  settingsUrl: string;
  log: (message: string) => void;
}): { open: (view?: 'chat' | 'config', activate?: boolean) => void } {
  let window: CompanionWindow | undefined;
  let ready = false;
  let currentView = 'chat';
  let focusWhenReady = true;
  const reveal = (): void => {
    if (!window || window.isDestroyed() || !ready) return;
    window.showInactive();
    if (focusWhenReady) window.focus();
  };
  return {
    open(view = 'chat', activate = true) {
      focusWhenReady = activate;
      if (window && !window.isDestroyed() && currentView === view) {
        reveal();
        return;
      }
      const address = new URL(deps.settingsUrl);
      address.searchParams.set('view', view);
      currentView = view;
      if (!window || window.isDestroyed()) {
        ready = false;
        const next = deps.create({
          title: '大肥鱼 · Codex 文字与语音',
          width: 680,
          height: 800,
          minWidth: 380,
          minHeight: 480,
          show: false,
          autoHideMenuBar: true,
          backgroundColor: '#fffafa',
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
            autoplayPolicy: 'no-user-gesture-required',
          },
        });
        window = next;
        next.once('ready-to-show', () => {
          if (window === next) {
            ready = true;
            reveal();
          }
        });
        next.once('closed', () => {
          if (window === next) {
            window = undefined;
            ready = false;
          }
        });
      }
      void window
        .loadURL(address.href)
        .then(reveal)
        .catch(() => deps.log('聊天窗口加载失败，请从托盘重新打开聊天。'));
    },
  };
}
