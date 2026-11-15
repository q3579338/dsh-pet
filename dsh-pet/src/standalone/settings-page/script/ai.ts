/**
 * 「AI 服务商」面板：独立模式自己的模型接入配置（协议、地址、模型、密钥、测试连接与删除密钥）。
 *
 * 读写独立模式专属的 /standalone-ai/settings，与插件配置那份文件互不相干；
 * 密钥只写不回显，请求一律带本次运行的访问令牌。AI 是否可用只看地址、模型与密钥是否齐全。
 * @module dsh-pet/src/standalone/settings-page/script/ai
 */

/** 生成 AI 面板片段。 */
export function aiScript(): string {
  return `
const AI_SETTINGS_URL = '/standalone-ai/settings';
const AI_TEST_URL = '/standalone-ai/test';
const AI_BALANCE_URL = '/standalone-ai/balance';
let previousModelProtocol = null;
const protocolModels = new Map();

function syncProtocolFields() {
  const codex = protocolSelect && protocolSelect.getValue() === 'codex';
  const workbuddy = protocolSelect && protocolSelect.getValue() === 'workbuddy';
  const balanceResult = byId('balance-result');
  const protocol = protocolSelect && protocolSelect.getValue();
  if (previousModelProtocol !== protocol) {
    if (previousModelProtocol !== null) {
      protocolModels.set(previousModelProtocol, byId('model').value);
      byId('model').value = protocolModels.get(protocol) || (codex ? 'default' : workbuddy ? 'deepseek-v4-flash' : '');
    }
    previousModelProtocol = protocol;
  }
  if (balanceResult && balanceResult.dataset.protocol !== protocol) {
    balanceResult.textContent = '';
    balanceResult.dataset.protocol = protocol;
  }
  for (const id of ['baseUrl', 'apiKey', 'deepseekApiKey']) {
    const field = byId(id) && byId(id).closest('.field');
    if (field) field.hidden = codex || workbuddy;
  }
  if (byId('codex-note')) byId('codex-note').hidden = !codex;
  if (byId('workbuddy-note')) byId('workbuddy-note').hidden = !workbuddy;
  if (byId('balance-provider-host')) byId('balance-provider-host').hidden = codex || workbuddy;
  if (byId('balance-provider-label')) byId('balance-provider-label').textContent = codex ? 'Codex 额度与用量' : workbuddy ? 'WorkBuddy 额度' : '余额查询服务商';
  if (byId('balance-provider-note')) byId('balance-provider-note').textContent = codex
    ? '读取当前 Codex 的套餐、窗口剩余额度、重置时间、额外点数和 Token 活动。额外点数以 Credits 显示；结果最多缓存 30 秒。'
    : workbuddy ? '请在 WorkBuddy 中查看额度，当前接入未提供余额查询。' : '选定余额服务商后，用保存的对应密钥查询余额。';
  if (byId('balance-btn')) {
    byId('balance-btn').textContent = codex ? '刷新 Codex 额度与用量' : '查询余额';
    byId('balance-btn').hidden = workbuddy;
    byId('balance-btn').disabled = workbuddy || (!codex && (!balanceSelect || balanceSelect.getValue() === ''));
  }
  byId('model').placeholder = codex ? 'default：跟随本机 Codex，或从列表选择' : workbuddy ? '从 WorkBuddy 内置模型在线目录选择' : '填写或拉取模型 ID';
  if (byId('model-note')) byId('model-note').textContent = workbuddy ? '点右侧箭头读取 WorkBuddy 在线内置模型目录，DeepSeek 优先显示；选好后点击测试连接确认实际可用。' : '可以直接手填；点右侧箭头拉取模型列表后选择，选择后保存到本机。';
  if (codex && !byId('model').value.trim()) byId('model').value = 'default';
  if (workbuddy && !byId('model').value.trim()) byId('model').value = 'deepseek-v4-flash';
}

async function aiRequest(method, body) {
  const response = await fetch(AI_SETTINGS_URL, {
    method: method,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
    headers: body
      ? { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' }
      : { 'X-DSH-Pet-Token': TOKEN },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    if (response.status === 403) throw new Error('打开凭据已失效。请从桌宠菜单重新打开设置。');
    if (response.status === 429) throw new Error('保存过于频繁，请稍等一分钟再试。');
    throw new Error('设置未保存。请检查接口地址、模型名称与密钥，再重试。');
  }
  return response.json();
}

function populateAi(data) {
  if (data.protocol !== undefined && protocolSelect) protocolSelect.setValue(String(data.protocol));
  for (const id of ['baseUrl', 'model']) {
    if (data[id] !== undefined && byId(id)) byId(id).value = String(data[id]);
  }
  if (data.balanceProvider !== undefined && balanceSelect) balanceSelect.setValue(String(data.balanceProvider));
  byId('balance-btn').disabled = !balanceSelect || balanceSelect.getValue() === '';
  byId('key-state').textContent = data.hasKey ? '已保存 · 不回显' : '尚未设置';
  byId('key-actions').hidden = data.hasKey !== true;
  byId('apiKey').value = '';
  byId('apiKey').disabled = false;
  byId('deepseek-key-state').textContent = data.hasDeepseekKey ? '已保存 · 不回显' : '尚未设置';
  byId('deepseek-key-actions').hidden = data.hasDeepseekKey !== true;
  byId('deepseekApiKey').value = '';
  byId('deepseekApiKey').disabled = false;
  syncProtocolFields();
  markDirty(false, 'ai');
}

/** 把余额结果翻成一行可读文案；失败一律说明原因，不显示伪造数字。 */
function describeBalance(data) {
  if (!data || data.ok !== true) {
    if (data && data.provider === 'codex' && typeof data.message === 'string') return data.message;
    if (data && data.reason === 'credential-missing') return '缺少密钥：请先保存所选服务商的 API 密钥。';
    if (data && data.reason === 'unsupported') return '该服务商不提供余额查询。';
    return data && data.message ? '查询失败：' + data.message : '查询失败，请稍后重试。';
  }
  const payload = data.data || {};
  if (data.shape === 'money' && payload.wallets) {
    return payload.wallets
      .map(function (wallet) {
        return wallet.currency + ' ' + wallet.total;
      })
      .join(' / ');
  }
  if (data.shape === 'points') return payload.total + ' ' + payload.unit;
  if (data.shape === 'windows') return '月度已用 ' + payload.monthly + '%';
  if (data.provider === 'codex' && data.shape === 'custom' && Array.isArray(payload.views)) {
    function lines(node, depth) {
      if (!node || depth > 6) return [];
      return (typeof node.text === 'string' ? [node.text] : []).concat(
        (Array.isArray(node.children) ? node.children.slice(0, 24) : []).flatMap(function(child) { return lines(child, depth + 1); })
      );
    }
    return payload.views.slice(0, 4).map(function(view) { return lines(view, 0).join('\\n'); }).join('\\n\\n');
  }
  return '已取到余额数据。';
}

function wireBalanceQuery() {
  const button = byId('balance-btn');
  const result = byId('balance-result');
  button.addEventListener('click', async () => {
    const queriedProtocol = protocolSelect && protocolSelect.getValue();
    button.disabled = true;
    result.className = queriedProtocol === 'codex' ? 'status codex-balance' : 'status';
    result.dataset.ok = '';
    result.dataset.error = '';
    result.textContent = queriedProtocol === 'codex' ? '正在读取 Codex 额度与用量…' : '正在查询余额…';
    try {
      const response = await fetch(AI_BALANCE_URL, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-DSH-Pet-Token': TOKEN },
      });
      if (!response.ok) throw new Error('查询被拒绝（HTTP ' + response.status + '）');
      const data = await response.json();
      if (protocolSelect && protocolSelect.getValue() !== queriedProtocol) return;
      const ok = data && data.ok === true;
      if (ok) result.dataset.ok = 'true';
      else result.dataset.error = 'true';
      result.textContent = (ok ? '✓ ' : '✗ ') + describeBalance(data);
    } catch (error) {
      if (protocolSelect && protocolSelect.getValue() !== queriedProtocol) return;
      result.dataset.error = 'true';
      result.textContent = '✗ ' + (error && error.message ? error.message : String(error));
    } finally {
      button.disabled = (protocolSelect && protocolSelect.getValue() === 'workbuddy') || (!(protocolSelect && protocolSelect.getValue() === 'codex') && (!balanceSelect || balanceSelect.getValue() === ''));
    }
  });
}

function wireKeyDelete(status) {
  byId('key-delete').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '删除已保存的密钥',
      text: '删除后桌宠将无法再调用模型，需要重新填写密钥才能恢复。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    setStatus(status, '正在删除密钥…');
    try {
      populateAi(await aiRequest('POST', { clearApiKey: true }));
      setStatus(status, '已删除保存的密钥。', 'ok');
    } catch (error) {
      setStatus(status, error && error.message ? error.message : String(error), 'error');
    }
  });
}

function wireDeepseekKeyDelete(status) {
  byId('deepseek-key-delete').addEventListener('click', async () => {
    const confirmed = await confirmDialog({
      title: '删除已保存的语音密钥',
      text: '删除后 DeepSeek 语音将不可用，直到重新填写密钥。',
      confirmLabel: '删除',
      danger: true,
    });
    if (!confirmed) return;
    setStatus(status, '正在删除语音密钥…');
    try {
      populateAi(await aiRequest('POST', { clearDeepseekKey: true }));
      setStatus(status, '已删除保存的语音密钥。', 'ok');
    } catch (error) {
      setStatus(status, error && error.message ? error.message : String(error), 'error');
    }
  });
}

function wireTest(testBtn, testResult) {
  testBtn.addEventListener('click', async () => {
    testBtn.disabled = true;
    testResult.className = 'status';
    testResult.textContent = '正在测试连接，请稍候…';
    const input = {
      protocol: protocolSelect ? protocolSelect.getValue() : 'openai-compatible',
      baseUrl: byId('baseUrl').value.trim(),
      model: byId('model').value.trim(),
      apiKey: byId('apiKey').value.trim(),
    };
    try {
      const response = await fetch(AI_TEST_URL, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'X-DSH-Pet-Token': TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      const data = await response.json();
      if (data.ok) {
        testResult.className = 'status';
        testResult.dataset.ok = 'true';
        testResult.textContent = '✓ ' + data.message;
        if (data.reply) testResult.textContent += '；回复：' + data.reply;
      } else {
        testResult.className = 'status';
        testResult.dataset.error = 'true';
        testResult.textContent = '✗ ' + (data.message || data.error || '测试失败');
      }
    } catch (error) {
      testResult.className = 'status';
      testResult.dataset.error = 'true';
      testResult.textContent = '✗ 请求异常：' + (error && error.message ? error.message : String(error));
    } finally {
      testBtn.disabled = false;
    }
  });
}

function wireSave(form, save, status) {
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    save.disabled = true;
    setStatus(status, '正在保存到本机…');
    const input = {
      protocol: protocolSelect ? protocolSelect.getValue() : 'openai-compatible',
      baseUrl: byId('baseUrl').value.trim(),
      model: byId('model').value.trim(),
      balanceProvider: balanceSelect ? balanceSelect.getValue() : '',
      apiKey: byId('apiKey').value,
      deepseekApiKey: byId('deepseekApiKey').value,
    };
    byId('apiKey').value = '';
    byId('deepseekApiKey').value = '';
    try {
      populateAi(await aiRequest('POST', input));
      setStatus(status, '已保存到本机。', 'ok');
    } catch (error) {
      setStatus(status, error && error.message ? error.message : String(error), 'error');
    } finally {
      save.disabled = false;
    }
  });
}

function wireAiPanel() {
  for (const kind of ['input', 'change']) byId('settings').addEventListener(kind, () => markDirty(true, 'ai'));
  wireModelPicker();
  const status = byId('status');
  wireKeyDelete(status);
  wireDeepseekKeyDelete(status);
  wireTest(byId('test-btn'), byId('test-result'));
  wireBalanceQuery();
  wireSave(byId('settings'), byId('save'), status);
}
`;
}
