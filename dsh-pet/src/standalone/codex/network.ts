/** 继承本机代理给自己启动的 Codex，不修改 Windows、Codex 或当前进程的配置。 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

/** 将 Windows 的单地址或分协议代理转换为子进程可用的 HTTP 地址。 */
export function windowsProxyUrl(raw: string): string | undefined {
  const entries = raw.trim().split(';');
  const address = raw.includes('=')
    ? (entries.find((entry) => entry.startsWith('https='))?.slice(6) ??
      entries.find((entry) => entry.startsWith('http='))?.slice(5))
    : raw.trim();
  if (!address) return undefined;
  try {
    const url = new URL(address.includes('://') ? address : 'http://' + address);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** 环境里显式指定的代理优先；读取失败时保留原环境，绝不把注册表内容写入日志。 */
export function codexChildEnvironment(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const childEnv = { ...env };
  if (
    process.platform !== 'win32' ||
    ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'].some((key) => env[key])
  )
    return childEnv;
  try {
    const output = execFileSync(
      join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'),
      ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'],
      { encoding: 'utf8', windowsHide: true, timeout: 1500 },
    );
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(output)) return childEnv;
    const proxy = windowsProxyUrl(output.match(/ProxyServer\s+REG_SZ\s+([^\r\n]+)/)?.[1] ?? '');
    if (proxy) {
      childEnv.HTTPS_PROXY = proxy;
      childEnv.HTTP_PROXY = proxy;
      childEnv.NO_PROXY = env.NO_PROXY ?? env.no_proxy ?? 'localhost,127.0.0.1,::1';
    }
  } catch {
    // PAC、认证代理或不可读的系统配置继续交给 Codex 自身处理。
  }
  return childEnv;
}
