/** 只模拟自有运行管道，不访问账号、网络或系统输入。 */
const { createInterface } = require('node:readline');
const lines = createInterface({ input: process.stdin });
const emit = (id, event) => process.stdout.write(JSON.stringify({ id, event }) + '\n');
lines.on('line', (line) => {
  const { id, input } = JSON.parse(line);
  if (input.mode === 'hang') return;
  if (input.mode === 'invalid') {
    emit(id + 1000, { type: 'text', text: 'private upstream error' });
    return;
  }
  if (input.action === 'models') emit(id, { type: 'models', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek' }] });
  else {
    emit(id, { type: 'model', model: 'deepseek-v4-flash' });
    emit(id, { type: 'text', text: '大肥鱼' + process.pid });
  }
  emit(id, { type: 'done' });
});
