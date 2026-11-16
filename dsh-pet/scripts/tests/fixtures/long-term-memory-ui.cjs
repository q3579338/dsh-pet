/** 只在隔离、离屏的原生测试里运行，不接真实麦克风或用户存档。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
module.exports = async ({ chat, js, origin, headers, run }) => {
  const wait = (ms) => new Promise((done) => setTimeout(done, ms));
  const until = async (code) => {
    for (let i = 0; i < 100; i++) {
      if (await js(code)) return;
      await wait(50);
    }
    throw Error('Memory UI timeout: ' + code);
  };
  const api = async (method, extra = '', body) => {
    const response = await fetch(origin + '/dsh-pet-7340/chat/long-term-memory?pet=main' + extra, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    return response.json();
  };
  const before = await api('GET');
  assert.equal(before.ok, true);
  await js("document.querySelector('#tab-memory').click()");
  await until("document.querySelector('#memory-status').textContent.includes('已读取')");
  assert.equal(await js("document.querySelector('#memory-items').textContent.includes('记忆测试星')"), true);
  // 输入、刷新、关闭保护都保留独立草稿。
  await js(
    "(()=>{const input=document.querySelector('#memory-text');input.value='用户喜欢桌游';input.dispatchEvent(new Event('input',{bubbles:true}));})()",
  );
  assert.equal(await js("document.querySelector('#dirty').hidden"), false);
  await js("document.querySelector('#memory-refresh').click()");
  await until("document.querySelector('#memory-status').textContent.includes('已读取')");
  assert.equal(await js("document.querySelector('#memory-text').value"), '用户喜欢桌游');
  await js("document.querySelector('#memory-save').click()");
  await until("document.querySelector('#memory-status').textContent.includes('已保存到本机')");
  assert.equal(await js("document.querySelector('#dirty').hidden"), true);
  let state = await api('GET');
  const fact = state.facts.find((row) => row.text === '用户喜欢桌游');
  assert.ok(fact);
  await js(
    "[...document.querySelectorAll('.memory-item')].find(row=>row.textContent.includes('用户喜欢桌游')).querySelector('button').click()",
  );
  await js(
    "(()=>{const input=document.querySelector('#memory-text');input.value='用户不喜欢桌游';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#memory-save').click();})()",
  );
  await until("document.querySelector('#memory-status').textContent.includes('已保存到本机')");
  state = await api('GET');
  assert.equal(state.facts.find((row) => row.id === fact.id).text, '用户不喜欢桌游');
  // 200 + 业务失败同样显示失败，不能伪报保存成功。
  await js(
    "(()=>{const input=document.querySelector('#memory-text');input.value='用户的密码是不可保存';input.dispatchEvent(new Event('input',{bubbles:true}));document.querySelector('#memory-save').click();})()",
  );
  await until("document.querySelector('#memory-status').dataset.error==='true'");
  assert.equal(
    (await api('GET')).facts.some((row) => row.text.includes('不可保存')),
    false,
  );
  assert.equal(await js("document.querySelector('#dirty').hidden"), false);
  await js("document.querySelector('#memory-edit-cancel').click()");
  await js("document.querySelector('#memory-enabled').click()");
  await until("document.querySelector('#memory-status').textContent.includes('已保存到本机')");
  assert.equal((await api('GET')).enabled, false);
  await js("document.querySelector('#memory-enabled').click()");
  await until("document.querySelector('#memory-status').textContent.includes('已保存到本机')");
  assert.equal((await api('GET')).enabled, true);
  chat.setSize(390, 844);
  await wait(80);
  assert.equal(await js('document.documentElement.scrollWidth<=window.innerWidth+1'), true);
  fs.writeFileSync(path.join(run, 'long-term-memory-offscreen.png'), (await chat.webContents.capturePage()).toPNG());
  await js("document.querySelector('#memory-clear').click()");
  assert.equal((await api('GET')).facts.length, state.facts.length, '确认前不能清空');
  await js("document.querySelector('#memory-confirm button').click()");
  await until("document.querySelector('#memory-status').textContent.includes('已保存到本机')");
  assert.equal((await api('GET')).facts.length, 0);
  assert.equal(await js("document.querySelector('#dirty').hidden"), true);
  await js("document.querySelector('[data-tab=config]').click()");
  return true;
};
