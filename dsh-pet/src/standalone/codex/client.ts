/**
 * Codex app-server 的本机 stdio 连接，负责 JSON-RPC 请求与子进程生命周期。
 * 每个连接只归一个调用方所有；退出、异常与取消都会拒绝未完成请求。
 * 凭据由已有 Codex 自行读取，stderr 与响应错误原文不展示给用户。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { resolveCodexExecutable } from './executable.ts';
import { codexChildEnvironment } from './network.ts';
import { codexFailure, CodexFailure } from './errors.ts';

/** 已解析的通知；载荷在消费处按事件种类校验。 */
export interface CodexNotification {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** 将外部 JSON 收成普通记录。 */
export function codexRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** 一个 app-server 进程与其未完成请求。 */
export class CodexClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly listeners = new Set<(notification: CodexNotification) => void>();
  private readonly closeListeners = new Set<(error: Error) => void>();
  private sequence = 0;
  private carry = '';
  private closed = false;

  constructor(cwd: string, executable = resolveCodexExecutable(), args = ['app-server', '--listen', 'stdio://']) {
    this.child = spawn(executable, args, {
      cwd,
      stdio: 'pipe',
      windowsHide: true,
      shell: false,
      env: codexChildEnvironment(),
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => this.receive(chunk));
    this.child.stderr.resume();
    this.child.stdin.on('error', () => this.close(new CodexFailure('Codex 连接写入失败，请重试。')));
    this.child.on('error', () => this.close(new CodexFailure('无法启动本机 Codex，请检查程序路径与登录状态。')));
    this.child.on('exit', () => this.close(new CodexFailure('Codex 连接已关闭，请重试。')));
  }

  /** 按官方顺序完成握手；不创建对话，也不发起模型请求。 */
  async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'codex_bigfish', title: '大肥鱼 Codex', version: '0.4.9' },
      capabilities: { experimentalApi: true },
    });
    this.send({ method: 'initialized', params: {} });
  }

  /** 请求有独立超时，关闭连接后不会留下永久等待的 Promise。 */
  request(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new CodexFailure('Codex 连接已关闭，请重试。'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexFailure('等待 Codex 响应超时，请检查网络或代理后重试。'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  /** 注册通知监听，返回精确解除函数。 */
  onNotification(listener: (notification: CodexNotification) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** 流消费者也必须知道子进程意外退出。 */
  onClose(listener: (error: Error) => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  /** 缓存连接只复用仍然存活的自己启动的子进程。 */
  isAlive(): boolean {
    return !this.closed && this.child.exitCode === null && !this.child.killed;
  }

  /** 关闭自己启动的进程，不触碰用户正在使用的 Codex 桌面端。 */
  close(error = new Error('Codex 连接已关闭。')): void {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const listener of this.closeListeners) listener(error);
    this.closeListeners.clear();
    this.listeners.clear();
    this.child.stdin.end();
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill();
    }, 1500);
    timer.unref();
  }

  /** 写失败走统一关闭路径，错误中不包含请求正文。 */
  private send(message: Record<string, unknown>): void {
    if (this.closed) return;
    this.child.stdin.write(JSON.stringify(message) + '\n', (error) => {
      if (error) this.close(new Error('Codex 连接写入失败，请重试。'));
    });
  }

  /** 仅消费完整 JSON 行，跨块的 UTF-8 由 Node 解码器处理。 */
  private receive(chunk: string): void {
    this.carry += chunk;
    if (this.carry.length > 4_000_000) return this.close(new Error('Codex 返回的数据过大。'));
    let newline: number;
    while ((newline = this.carry.indexOf('\n')) >= 0) {
      const line = this.carry.slice(0, newline);
      this.carry = this.carry.slice(newline + 1);
      try {
        this.dispatch(codexRecord(JSON.parse(line)));
      } catch {
        /* 非协议日志不能当成成功响应。 */
      }
    }
  }

  /** 桌宠不会代表用户批准工具执行、权限申请或外部操作。 */
  private dispatch(message: Record<string, unknown>): void {
    if (typeof message.id === 'number' && typeof message.method !== 'string') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(codexFailure(message.error));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;
    if (message.id !== undefined) {
      this.send({
        id: message.id,
        error: { code: -32601, message: 'Desktop companion does not approve tool actions.' },
      });
      this.close(new Error('本次对话需要额外操作授权，请回到 Codex 处理。'));
      return;
    }
    const notification = { method: message.method, params: codexRecord(message.params) };
    for (const listener of this.listeners) listener(notification);
  }
}
