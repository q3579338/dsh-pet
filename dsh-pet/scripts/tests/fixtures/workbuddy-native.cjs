const assert = require('node:assert/strict');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (b) => (input += b));
process.stdin.on('end', () => {
  const request = JSON.parse(input);
  if (request.action === 'models') {
    console.log(
      JSON.stringify({
        type: 'models',
        models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }, { id: 'glm-5.0-turbo' }, { id: 'kimi-k2.6' }],
      }),
    );
    console.log('{"type":"done"}');
    return;
  }
  assert.equal(request.action, 'chat');
  assert.equal(request.model, 'deepseek-v4-flash');
  assert.equal(request.request.messages[0].role, 'user');
  if (process.env.FISH_CLI_MODE === 'hang') {
    setInterval(() => {}, 1000);
    return;
  }
  if (process.env.FISH_CLI_MODE === 'auth') {
    console.log('{"type":"error","code":"auth","private":"secret"}');
    return;
  }
  console.log('{"type":"model","model":"deepseek-v4-flash"}');
  const part = Buffer.from(JSON.stringify({ type: 'text', text: '大肥鱼' }) + '\n');
  const cut = part.indexOf(Buffer.from('大')) + 1;
  process.stdout.write(part.subarray(0, cut));
  setTimeout(() => {
    process.stdout.write(part.subarray(cut));
    console.log('{"type":"text","text":"来啦！"}');
    console.log('{"type":"done"}');
  }, 10);
});
