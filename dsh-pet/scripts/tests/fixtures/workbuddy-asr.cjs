const { createInterface } = require('node:readline');
const mode = process.env.FISH_ASR_MODE;
if (mode !== 'hang') console.log('{"type":"asr-ready"}');
createInterface({ input: process.stdin }).on('line', (line) => {
  const value = JSON.parse(line);
  if (value.type === 'audio') {
    if (mode === 'error') console.log('{"type":"error","code":"auth","private":"secret-token"}');
    else console.log('{"type":"asr-partial","text":"测试"}');
  }
  if (value.type === 'finish') console.log('{"type":"asr-final","text":"测试。"}');
});
