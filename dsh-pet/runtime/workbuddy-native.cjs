/**
 * 由已安装的国内版 WorkBuddy 以 Node 模式运行。
 * 只读当前桌面登录；调用该安装自带的解码组件，不复制账号文件或密钥。
 * 父进程只能得到在线模型目录、回复正文、服务端模型 ID 和固定失败类别。
 */
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const ORIGIN = 'https://www.workbuddy.cn';

function failure(code) {
  const error = new Error(code);
  error.publicCode = code;
  return error;
}
function modelId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value) && !value.startsWith('custom');
}
function inputRequest(value) {
  if (!value || typeof value !== 'object' || !['models', 'chat', 'balance', 'hear'].includes(value.action))
    throw failure('input');
  if (value.action === 'models' || value.action === 'balance') return { action: value.action };
  if (value.action === 'hear') {
    if (
      typeof value.audio !== 'string' ||
      value.audio.length > 3000000 ||
      value.audio.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(value.audio)
    )
      throw failure('input');
    return { action: 'hear', audio: value.audio };
  }
  const request = value.request;
  if (
    !modelId(value.model) ||
    !request ||
    typeof request.system !== 'string' ||
    !Array.isArray(request.messages) ||
    !request.messages.length ||
    request.messages.length > 64 ||
    !Number.isInteger(value.maxTokens) ||
    value.maxTokens < 128 ||
    value.maxTokens > 4096
  )
    throw failure('input');
  let chars = request.system.length;
  for (const message of request.messages) {
    if (!message || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string')
      throw failure('input');
    chars += message.content.length;
  }
  if (chars > 32768 || request.images?.length) throw failure('input');
  return value;
}

function catalogModels(body) {
  const data = body?.data;
  if (body?.code !== 0 || !data || !Array.isArray(data.models)) throw failure('upstream');
  const agents = (Array.isArray(data.agents) ? data.agents : []).filter(
    (agent) => agent && Array.isArray(agent.models) && agent.models.length,
  );
  const picker =
    agents.find((agent) => Array.isArray(agent.tags) && agent.tags.includes('default')) ||
    agents.find((agent) => agent.name === 'cli') ||
    agents[0];
  const visible = new Set(picker ? picker.models.filter((id) => typeof id === 'string') : []);
  for (const model of data.models) if (Array.isArray(model?.tags) && model.tags.includes('chat')) visible.add(model.id);
  const seen = new Set(),
    models = [];
  for (const raw of data.models.slice(0, 500)) {
    if (
      !raw ||
      !modelId(raw.id) ||
      (visible.size > 0 && !visible.has(raw.id)) ||
      seen.has(raw.id) ||
      /(?:image|video|completion|embedding|^codewise-)/i.test(raw.id) ||
      raw.maxInputTokens === 0 ||
      raw.maxOutputTokens === 0
    )
      continue;
    seen.add(raw.id);
    models.push({ id: raw.id, name: typeof raw.name === 'string' ? raw.name.slice(0, 150) : raw.id });
  }
  if (!models.length) throw failure('model');
  return models.sort((a, b) => Number(b.id.startsWith('deepseek')) - Number(a.id.startsWith('deepseek')));
}

/** 上游错误正文只用于选择固定类别，不离开辅助进程。 */
function upstreamFailure(status, body) {
  const message = String(body?.msg ?? body?.message ?? body?.error?.message ?? '');
  if (status === 401 || status === 403 || /auth|token|login|sign.in/i.test(message)) return failure('auth');
  if (status === 429 || /quota|credit|balance|limit|insufficient/i.test(message)) return failure('quota');
  if (/model|reasoning|effort/i.test(message)) return failure('model');
  return failure('upstream');
}

/** 不构造新的凭据或身份；读取指定国内版安装的官方组件和活动文件。 */
function nativeSession() {
  let boot, protection, material, codec;
  try {
    const resources = path.join(path.dirname(process.execPath), 'resources');
    const product = JSON.parse(fs.readFileSync(path.join(resources, 'app.asar.unpacked/cli/product.json'), 'utf8'));
    if (new URL(product.endpoint).origin !== ORIGIN || product.authentication?.id !== 'workbuddy-desktop')
      throw failure('region');
    const root = path.join(resources, 'app.asar');
    boot = require(path.join(root, 'main/src.js'));
    protection = require(path.join(root, 'main/credential-protection.js'));
    boot.t();
    protection.t();
    // 原生载荷只交给同一安装的官方解析器，不序列化到管道、日志、环境变量或磁盘。
    material = boot._(process._linkedBinding('electron_browser_workbuddy_storage').loggerGet());
    if (material.symmetric?.status !== 'available') throw failure('unsupported');
    protection._({ policy: 'fields', symmetricKey: material.symmetric.value });
    const file = path.join(process.env.LOCALAPPDATA, 'CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info');
    if (fs.existsSync(file + '.logged-out')) throw failure('auth');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw failure('auth');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    codec = protection.v({ purpose: 'workbuddy-auth-session', resourceId: 'auth/workbuddy-desktop.info' });
    let session;
    try {
      session = codec.decode(raw, protection.l).value;
    } catch {
      throw failure('auth');
    }
    const auth = session?.auth;
    if (
      typeof auth?.accessToken !== 'string' ||
      !auth.accessToken ||
      (Number(auth.expiresAt) > 0 && Number(auth.expiresAt) <= Date.now())
    )
      throw failure('auth');
    if (typeof auth.domain !== 'string' || /workbuddy\.ai|codebuddy\.ai/i.test(auth.domain)) throw failure('region');
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    let claims = {};
    try {
      claims = JSON.parse(Buffer.from(auth.accessToken.split('.')[1], 'base64url').toString('utf8'));
    } catch {
      /* 令牌格式交由服务端验证。 */
    }
    const headers = {
      Authorization: 'Bearer ' + auth.accessToken,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-IDE-Type': 'WorkBuddy',
      'X-IDE-Name': 'WorkBuddy',
      'X-Product': 'WorkBuddy',
      'X-Product-Version': version,
      'X-IDE-Version': version,
      'X-Agent-Purpose': 'conversation',
      'X-CodeBuddy-Request': '1',
      'X-Domain': auth.domain,
      'User-Agent': 'WorkBuddy/' + version + ' Electron/' + process.versions.electron,
    };
    if (typeof claims.sub === 'string') headers['X-User-Id'] = claims.sub;
    if (typeof claims.enterprise_id === 'string') headers['X-Enterprise-Id'] = claims.enterprise_id;
    return { headers };
  } catch (error) {
    throw error?.publicCode ? error : failure('unsupported');
  } finally {
    codec?.dispose();
    protection?.b?.();
    material?.symmetric?.value?.key?.fill(0);
  }
}

async function jsonBody(response) {
  const decoder = new TextDecoder();
  let text = '',
    bytes = 0;
  for await (const part of response.body) {
    bytes += part.length;
    if (bytes > 4 * 1024 * 1024) throw failure('upstream');
    text += decoder.decode(part, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw failure('upstream');
  }
}

/** SSE 只提取标准文字与型号；思考、工具及其它上游字段不进入宠物界面。 */
function chatFrames() {
  let complete = false,
    chars = 0,
    reportedModel = '';
  return {
    accept(line) {
      if (!line.startsWith('data:')) return [];
      const text = line.slice(5).trim();
      if (text === '[DONE]') {
        complete = true;
        return [];
      }
      if (complete) throw failure('upstream');
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        throw failure('upstream');
      }
      if (value.error || (value.code && value.code !== 0)) throw upstreamFailure(200, value);
      const choice = value.choices?.[0],
        frames = [];
      if (
        (Array.isArray(choice?.delta?.tool_calls) && choice.delta.tool_calls.length > 0) ||
        choice?.finish_reason === 'tool_calls'
      )
        throw failure('upstream');
      if (modelId(value.model) && value.model !== reportedModel) {
        reportedModel = value.model;
        frames.push({ type: 'model', model: reportedModel });
      }
      if (typeof choice?.delta?.content === 'string') {
        chars += choice.delta.content.length;
        if (chars > 16384) throw failure('upstream');
        if (choice.delta.content) frames.push({ type: 'text', text: choice.delta.content });
      }
      return frames;
    },
    finish() {
      if (!complete || !chars) throw failure('upstream');
    },
  };
}

async function runRequest(input, emit, fetcher = fetch, getSession = nativeSession) {
  const request = inputRequest(input);
  const { headers } = getSession();
  try {
    if (request.action === 'balance') {
      const response = await fetcher(ORIGIN + '/billing/meter/get-user-resource-summary', {
        method: 'POST',
        headers: { ...headers, 'Accept-Language': 'zh' },
        body: '{}',
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      const body = await jsonBody(response);
      if (!response.ok || body?.code !== 0) throw upstreamFailure(response.status, body);
      await emit({ type: 'balance', balance: resourceBalance(body.data) });
    } else if (request.action === 'hear') {
      const audio = Buffer.from(request.audio, 'base64');
      if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE')
        throw failure('input');
      const form = new FormData();
      form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'voice.wav');
      const asrHeaders = { ...headers };
      delete asrHeaders['Content-Type'];
      const response = await fetcher(ORIGIN + '/agenttool/v1/asr', {
        method: 'POST',
        headers: asrHeaders,
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(30000),
      });
      const body = await jsonBody(response);
      if (!response.ok || (body?.code !== undefined && body.code !== 0)) throw upstreamFailure(response.status, body);
      if (typeof body.text !== 'string' || body.text.length > 16000) throw failure('upstream');
      await emit({ type: 'transcript', text: body.text });
    } else if (request.action === 'models') {
      const response = await fetcher(ORIGIN + '/v3/config', {
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
      const body = await jsonBody(response);
      if (!response.ok) throw upstreamFailure(response.status, body);
      await emit({ type: 'models', models: catalogModels(body) });
    } else {
      const response = await fetcher(ORIGIN + '/v2/chat/completions', {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(55000),
        headers: {
          ...headers,
          'X-Model-ID': request.model,
          'X-Env-ID': 'production',
          'X-Conversation-ID': randomUUID(),
          'X-Request-ID': randomUUID(),
        },
        body: JSON.stringify({
          model: request.model,
          stream: true,
          max_tokens: request.maxTokens,
          messages: [
            ...(request.request.system ? [{ role: 'system', content: request.request.system }] : []),
            ...request.request.messages.map(({ role, content }) => ({ role, content })),
          ],
        }),
      });
      if (!response.ok || !(response.headers.get('content-type') ?? '').includes('text/event-stream'))
        throw upstreamFailure(response.status, await jsonBody(response));
      const frames = chatFrames(),
        decoder = new TextDecoder();
      let pending = '',
        bytes = 0;
      for await (const part of response.body) {
        bytes += part.length;
        if (bytes > 4 * 1024 * 1024) throw failure('upstream');
        pending += decoder.decode(part, { stream: true });
        if (pending.length > 1024 * 1024) throw failure('upstream');
        let end;
        while ((end = pending.indexOf('\n')) >= 0) {
          for (const frame of frames.accept(pending.slice(0, end).trimEnd())) await emit(frame);
          pending = pending.slice(end + 1);
        }
      }
      pending += decoder.decode();
      if (pending.trim()) for (const frame of frames.accept(pending.trimEnd())) await emit(frame);
      frames.finish();
    }
    await emit({ type: 'done' });
  } finally {
    headers.Authorization = '';
  }
}

/** 仅返回套餐名与服务端明确提供的积分数字，空响应不能当作零余额。 */
function resourceBalance(data) {
  if (!data || !Array.isArray(data.Packages) || data.Packages.length > 100) throw failure('upstream');
  const number = (value) => {
    if ((typeof value !== 'number' && typeof value !== 'string') || value === '') throw failure('upstream');
    const result = Number(value);
    if (!Number.isFinite(result) || result < 0) throw failure('upstream');
    return result;
  };
  if (!data.Packages.length) throw failure('upstream');
  const packages = data.Packages.map((p) => ({
    total: number(p.CycleTotalCapacity),
    left: number(p.CycleRemainCapacity),
    used: number(p.CycleUsedCapacity),
  }));
  const sum = (key) => packages.reduce((n, p) => n + p[key], 0);
  return {
    plan: typeof data.SubscriptionPackageName === 'string' ? data.SubscriptionPackageName.slice(0, 150) : '',
    total: sum('total'),
    left: sum('left'),
    used: sum('used'),
  };
}

/** 国内版自己的流式识别；令牌只留在本辅助进程，音频原样发送，不接入 Codex。 */
async function runAsr(emit) {
  const { createInterface } = require('node:readline');
  const { headers } = nativeSession();
  const root = path.join(path.dirname(process.execPath), 'resources/app.asar');
  const Socket = require(path.join(root, 'main/wrapper.js')).r;
  const socket = new Socket(
    ORIGIN.replace('https:', 'wss:') +
      '/clientcap/v2/asr/stream?source=desktop&interim_results=1&session_id=' +
      randomUUID(),
    { headers, followRedirects: false, maxPayload: 65536 },
  );
  let settled = false,
    ready = false,
    finishing = false,
    bytes = 0;
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  let runAsrStop;
  let timer = setTimeout(() => stop('upstream'), 12000);
  const done = new Promise((resolve) => {
    socket.on('message', (raw) => {
      if (settled) return;
      try {
        if (raw.length > 65536) throw failure('upstream');
        const value = JSON.parse(raw.toString('utf8'));
        if (value.code !== undefined && value.code !== 0) throw upstreamFailure(200, value);
        if (!ready) {
          ready = true;
          clearTimeout(timer);
          timer = setTimeout(() => stop('upstream'), 270000);
          void emit({ type: 'asr-ready' });
        }
        if (typeof value.text === 'string' && value.text.length > 16000) throw failure('upstream');
        if (value.final) {
          settled = true;
          clearTimeout(timer);
          void emit({ type: 'asr-final', text: value.noise_reject ? '' : (value.text ?? '') }).then(() => {
            socket.close();
            lines.close();
            resolve();
          });
        } else if (typeof value.text === 'string') void emit({ type: 'asr-partial', text: value.text });
      } catch (error) {
        stop(error?.publicCode ?? 'upstream');
      }
    });
    socket.on('error', () => stop('upstream'));
    socket.on('close', () => {
      if (!settled) stop('upstream');
    });
    lines.on('line', (line) => {
      if (settled) return;
      try {
        if (line.length > 24000 || !ready || socket.readyState !== Socket.OPEN) throw failure('input');
        const value = JSON.parse(line);
        if (value.type === 'finish' && !finishing) {
          finishing = true;
          clearTimeout(timer);
          timer = setTimeout(() => stop('upstream'), 12000);
          socket.send(Buffer.alloc(0));
        } else if (
          value.type === 'audio' &&
          !finishing &&
          typeof value.audio === 'string' &&
          value.audio.length % 4 === 0 &&
          /^[A-Za-z0-9+/]+={0,2}$/.test(value.audio)
        ) {
          const pcm = Buffer.from(value.audio, 'base64');
          bytes += pcm.length;
          if (!pcm.length || pcm.length % 2 || pcm.length > 16384 || bytes > 960000 || socket.bufferedAmount > 128000)
            throw failure('input');
          socket.send(pcm);
        } else throw failure('input');
      } catch (error) {
        stop(error?.publicCode ?? 'input');
      }
    });
    lines.on('close', () => {
      if (!settled) stop('upstream');
    });
    function stop(code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.terminate();
      lines.close();
      void emit({ type: 'error', code: ['auth', 'quota', 'input'].includes(code) ? code : 'upstream' }).then(resolve);
    }
    // 定时器只使用固定失败类别，绝不把底层异常文本输出。
    runAsrStop = stop;
  });
  function stop(code) {
    runAsrStop?.(code);
  }
  try {
    await done;
  } finally {
    headers.Authorization = '';
    clearTimeout(timer);
    socket.terminate();
    lines.close();
  }
}

module.exports = { inputRequest, catalogModels, chatFrames, runRequest, resourceBalance };
if (require.main === module) {
  process.stdout.on('error', () => process.exit(0));
  const emit = async (value) => {
    if (!process.stdout.write(JSON.stringify(value) + '\n')) await once(process.stdout, 'drain');
  };
  (async () => {
    if (process.argv.includes('--asr')) return runAsr(emit);
    if (process.argv.includes('--session')) {
      // 只复用网络连接；每次请求仍重新读取当前活动登录，不缓存账号令牌。
      const { createInterface } = require('node:readline');
      const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
      let previous = 0;
      for await (const line of lines) {
        if (line.length > 262144) throw failure('input');
        const value = JSON.parse(line);
        if (!Number.isSafeInteger(value.id) || value.id <= previous) throw failure('input');
        previous = value.id;
        const reply = (event) => emit({ id: value.id, event });
        try {
          await runRequest(value.input, reply);
        } catch (error) {
          await reply({
            type: 'error',
            code: ['auth', 'region', 'unsupported', 'model', 'quota', 'input'].includes(error?.publicCode)
              ? error.publicCode
              : 'upstream',
          });
        }
      }
      return;
    }
    let bytes = 0;
    const chunks = [];
    for await (const part of process.stdin) {
      bytes += part.length;
      if (bytes > 3100000) throw failure('input');
      chunks.push(part);
    }
    let input;
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      throw failure('input');
    }
    await runRequest(input, emit);
  })().catch(async (error) => {
    await emit({
      type: 'error',
      code: ['auth', 'region', 'unsupported', 'model', 'quota', 'input'].includes(error?.publicCode)
        ? error.publicCode
        : 'upstream',
    });
    process.exitCode = 1;
  });
}
