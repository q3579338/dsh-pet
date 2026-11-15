/**
 * 桌面入口的进程分流：DPI 子进程在单实例锁之前独立退出，普通进程再启动服务。
 * 探测只读显示器缩放、使用独立 Chromium 目录，不创建窗口或访问宠物配置。
 */
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** 启动分流需要的 Electron 能力，不依赖 Electron 类型包。 */
export interface StartupApp {
  setName(name: string): void;
  getPath(name: 'appData'): string;
  setPath(name: 'userData', path: string): void;
  commandLine: { getSwitchValue(name: string): string };
  disableHardwareAcceleration(): void;
  whenReady(): Promise<void>;
  requestSingleInstanceLock(): boolean;
  exit(code?: number): void;
}

/** 屏幕数据仅在 Electron ready 后读取。 */
export interface DpiScreen {
  getPrimaryDisplay(): { scaleFactor: number };
}

/** 等待管道写入完成，避免退出太早丢掉 DPI 探测结果。 */
function stdoutLine(line: string): Promise<void> {
  return new Promise((done, reject) => process.stdout.write(line, (error) => (error ? reject(error) : done())));
}

/** DPI 探测不能等待被父进程持有的锁；普通实例尊重显式 user-data-dir。 */
export async function startDesktopEntry(options: {
  app: StartupApp;
  screen: DpiScreen;
  home: string;
  probe: boolean;
  boot: () => Promise<void>;
  writeProbe?: (line: string) => Promise<void>;
}): Promise<void> {
  const { app, screen, home, probe, boot, writeProbe = stdoutLine } = options;
  if (probe) {
    const directory = join(home, 'dpi-profile');
    mkdirSync(directory, { recursive: true });
    app.setName('Codex-BigFish-DPI');
    app.setPath('userData', directory);
    app.disableHardwareAcceleration();
    try {
      await app.whenReady();
      const scale = screen.getPrimaryDisplay().scaleFactor;
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('无法读取显示器缩放。');
      await writeProbe('dsh-pet-primary-scale:' + scale + '\n');
      app.exit(0);
    } catch {
      app.exit(1);
    }
    return;
  }

  const override = app.commandLine.getSwitchValue('user-data-dir');
  const directory = override ? resolve(override) : join(app.getPath('appData'), 'codex-bigfish');
  mkdirSync(directory, { recursive: true });
  app.setName('Codex-BigFish');
  app.setPath('userData', directory);
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
    return;
  }
  await boot();
}

/** 再次打开时显示已有宠物，保持当前键盘焦点。 */
export function revealExistingWindows(windows: readonly { isDestroyed(): boolean; showInactive(): void }[]): void {
  for (const window of windows) if (!window.isDestroyed()) window.showInactive();
}
