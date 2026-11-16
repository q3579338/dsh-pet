/**
 * 设置页 HTML 外壳：左侧固定分区导航 + 右侧内容区，配置页把桌宠与 AI 两块合并在一处。
 *
 * 页面只在本机回环上由 ./server 提供；CSP 是 `style-src 'self'`，所以这里不许出现内联样式，
 * 也不许内联脚本。桌宠配置面板的内容依赖 GET /config，初始只有一句占位文案。
 * 图标走设置页自己的公开资源路径（/standalone-ai/icon.png），内容读自包内 assets/logo.png，
 * 不复制第二份图；不能用插件路由 /logo——浏览器取 favicon 不带 Origin 也不带令牌，会被判成文件来源而 403。
 * 导航项以 `data-tab` 声明，脚本按约定找 `panel-<tab>`，新增分区只需照此加一对按钮与面板。
 * @module dsh-pet/src/standalone/settings-page/chrome
 */

/** 设置页 HTML。 */
export const settingsPage = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><base href="/"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>桌宠设置</title><link rel="icon" type="image/png" href="/standalone-ai/icon.png"><link rel="stylesheet" href="/standalone-ai/settings.css">
<script src="/standalone-ai/settings.js" defer></script><script src="/standalone-ai/chat-panel.js" defer></script></head><body>
<main class="shell">
<aside class="side">
<div class="brand"><img class="brandLogo" src="/standalone-ai/icon.png" alt=""><span>桌宠</span></div>
<nav class="nav" aria-label="设置分区"><div class="navList" role="tablist">
<button type="button" class="navCell" role="tab" id="tab-chat" data-tab="chat" data-title="对话" aria-controls="panel-chat" aria-selected="true"><svg class="navGlyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.4h10a1.1 1.1 0 0 1 1.1 1.1v5.6A1.1 1.1 0 0 1 13 11.2H8.2L5 13.6v-2.4H3a1.1 1.1 0 0 1-1.1-1.1V4.5A1.1 1.1 0 0 1 3 3.4Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg><span class="navLabel">对话</span></button>
<button type="button" class="navCell" role="tab" id="tab-config" data-tab="config" data-title="配置" aria-controls="panel-config" aria-selected="false"><svg class="navGlyph" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M2.6 4.6h10.8M2.6 11.4h10.8"/><circle cx="6.2" cy="4.6" r="1.6" fill="currentColor" stroke="none"/><circle cx="9.8" cy="11.4" r="1.6" fill="currentColor" stroke="none"/></g></svg><span class="navLabel">配置</span></button>
<button type="button" class="navCell" role="tab" id="tab-memory" data-tab="memory" data-title="长期记忆" aria-controls="panel-memory" aria-selected="false"><span class="navGlyph" aria-hidden="true">♡</span><span class="navLabel">记忆</span></button>
</div></nav>
<div class="sideFoot">大肥鱼 · Codex 适配<span id="app-version"></span></div>
</aside>
<div class="main">
<div class="topbar"><h1 class="pageTitle" id="page-title">对话</h1><span class="dirty" id="dirty" hidden>有未保存的改动</span></div>
<div class="options">
<section class="panel" id="panel-config" role="tabpanel" aria-labelledby="tab-config" hidden>
<div class="scroll">
<form id="settings" aria-describedby="privacy">
<div class="card" id="connection-source-card"><div class="cardHead"><h2 class="cardTitle">连接来源</h2><button id="save" class="btn primary" type="submit" disabled>保存连接</button></div>
<p class="status" id="status" role="status" aria-live="polite">正在读取本机设置…</p>
<p class="cardHint">对话、语音识别和订阅额度分别跟随所选来源，保存后生效。朗读音色独立保留；所有设置保存在本机。</p>
<div class="field"><span class="fieldLabel" id="protocol-label">选择 Codex / WorkBuddy</span><div id="protocol-host"></div></div>
<p class="cardHint" id="codex-note" hidden>沿用本机 Codex 的登录和默认模型，不需要安装 DeepSeek，也不用在这里填写 API 密钥。宠物聊天会使用你当前 Codex 连接的额度；任务联动只显示本机会话状态，不把其它聊天正文发给模型。默认自动找 Codex，找不到时可设置 DSH_PET_CODEX_PATH 后重新打开。</p>
<p class="cardHint" id="workbuddy-note" hidden>沿用国内版 WorkBuddy 登录，语音识别也使用 WorkBuddy 自己的服务；对话选择其内置 DeepSeek、GLM、Kimi 等模型。可查看当前套餐与真实积分余额，不调用 Codex 的识别或订阅。星铃、糖芽和团子继续作为独立朗读音色。登录失效时请在国内版 WorkBuddy 中恢复；附图和 Codex 原声只在 Codex 来源下使用。</p>
<div class="field"><label for="baseUrl">接口地址（Base URL）</label><input id="baseUrl" name="baseUrl" type="url" placeholder="https://example.com/v1" maxlength="2048" spellcheck="false" aria-describedby="endpoint-note"><p class="fieldHint" id="endpoint-note">服务商提供的基础接口地址，支持 HTTP 与 HTTPS，通常以 /v1 结尾。不要把密钥放进地址。</p></div>
<div class="field"><label for="model">模型名称</label><div class="combo" id="model-combo"><input id="model" name="model" type="text" maxlength="200" placeholder="填写或拉取服务商的模型 ID，例如 deepseek-chat" spellcheck="false" aria-describedby="model-note"><button id="model-toggle" class="comboToggle" type="button" aria-label="拉取并选择模型" aria-haspopup="listbox" aria-expanded="false"></button></div><p class="fieldHint" id="model-note">可以直接手填；点右侧箭头向端点拉取可用列表后选择。拉取只用本次填写的地址与密钥，不会保存。</p><p class="status" id="model-result" role="status" aria-live="polite"></p></div>
<div class="field"><label for="apiKey">API 密钥 <span class="hintInline" id="key-state">尚未读取</span></label><input id="apiKey" name="apiKey" type="password" autocomplete="new-password" maxlength="8192" placeholder="留空保留已保存的密钥" aria-describedby="key-note"><div class="keyActions" id="key-actions" hidden><button id="key-delete" class="btn ghost" type="button">删除已保存的密钥</button></div><p id="key-note" class="fieldHint">密钥只写入本机配置，不会回显。留空会保留旧密钥，要彻底删除请点上面的按钮。</p></div>
<div class="field"><label for="deepseekApiKey">DeepSeek 语音密钥 <span class="hintInline" id="deepseek-key-state">尚未读取</span></label><input id="deepseekApiKey" name="deepseekApiKey" type="password" autocomplete="new-password" maxlength="4096" placeholder="留空保留已保存的密钥" aria-describedby="deepseek-key-note"><div class="keyActions" id="deepseek-key-actions" hidden><button id="deepseek-key-delete" class="btn ghost" type="button">删除已保存的语音密钥</button></div><p id="deepseek-key-note" class="fieldHint">只给 DeepSeek 语音合成与识别用，和上面的对话密钥分开存——对话走别家服务商时也能单独用 DeepSeek 语音。留空则依次沿用「余额选 DeepSeek 时的那把密钥」。</p></div>
<div class="field"><span class="fieldLabel" id="balance-provider-label">余额查询服务商</span><div id="balance-provider-host"></div><p class="fieldHint" id="balance-provider-note">可选：选定后可用上面保存的密钥查询余额，不选则不查询。余额接口只有 DeepSeek 官方、opencode Go 与 commandcode 提供，且密钥必须属于所选服务商。</p><div class="testRow"><button id="balance-btn" class="btn ghost" type="button" disabled>查询余额</button><span id="balance-result" class="status" role="status" aria-live="polite"></span></div></div>
<div class="testRow"><button id="test-btn" class="btn" type="button">测试连接</button><span id="test-result" class="status" role="status" aria-live="polite"></span></div>
</div>
<p id="privacy" class="fineprint">所有配置与密钥仅保存在当前机器。</p>
</form>
<div class="card"><div class="cardHead"><h2 class="cardTitle">聊天与长期记忆</h2><button class="btn" type="button" id="open-long-term-memory">查看长期记忆</button></div><p class="cardHint">普通聊天记录仍保存在 memory.json。长期记忆另外保存用户明确表达的称呼、喜好和约定，文字与即时语音共用；切换模型也能继续使用。可在记忆页关闭、修改或删除。</p></div>
<div id="pet-cards"><p class="empty">正在读取本机配置…</p></div>
<div class="footer"><p class="status" id="pet-status" role="status" aria-live="polite"></p><button class="btn primary" id="pet-save" type="button" disabled>保存桌宠设置</button></div>
</div>
</section>
<section class="panel" id="panel-chat" role="tabpanel" aria-labelledby="tab-chat">
<div class="pet-chat-host" id="pet-chat-root"></div>
</section>
<section class="panel" id="panel-memory" role="tabpanel" aria-labelledby="tab-memory" hidden><div class="scroll">
<div class="card"><div class="cardHead"><h2 class="cardTitle">长期记忆 · 本机</h2><button class="btn" id="memory-refresh" type="button">刷新</button></div>
<p class="cardHint">自动整理你明确说过的称呼、喜好和约定。规则提取可能有遗漏，可在下方纠正。每只桌宠单独保存，Codex 与 WorkBuddy 共用同一只桌宠的记忆。</p>
<div class="field"><label for="memory-pet">选择桌宠</label><select id="memory-pet"></select></div>
<label class="memory-switch"><input id="memory-enabled" type="checkbox">自动记住并使用长期信息</label>
<p class="fieldHint">信息保存在本机，使用时会随提示词发送给当前模型。关闭后停止提取和使用，已有信息保留。修改或删除会结束当前语音，重新开始后生效。</p>
<p class="status" id="memory-status" role="status" aria-live="polite">选择此页后读取。</p>
<p class="fieldHint" id="memory-directory"></p></div>
<div class="card"><div class="cardHead"><h2 class="cardTitle">已记住的信息</h2><button class="btn" id="memory-clear" type="button">清空长期记忆</button></div><div id="memory-confirm" hidden></div><div id="memory-items"></div></div>
<div class="card"><h2 class="cardTitle">手动补充或纠正</h2><form id="memory-editor"><input type="hidden" id="memory-edit-id"><div class="field"><label for="memory-kind">类型</label><select id="memory-kind"><option value="profile">称呼与个人信息</option><option value="preference">喜好</option><option value="promise">约定</option><option value="relationship">关系</option><option value="event">重要事件</option><option value="lesson">习惯与经验</option></select></div><div class="field"><label for="memory-text">要记住的事实</label><textarea id="memory-text" rows="3" maxlength="360" required placeholder="例如：用户希望被称为「星宝」；用户不喜欢喝咖啡。"></textarea></div><div class="memory-actions"><button type="submit" class="btn primary" id="memory-save">保存这条记忆</button><button type="button" class="btn" id="memory-edit-cancel" hidden>取消修改</button></div></form></div>
</div></section>
</div>
</div>
</main>
<noscript>需要启用 JavaScript 才能保存设置。请从桌宠右键菜单打开本页。</noscript>
</body></html>`;
