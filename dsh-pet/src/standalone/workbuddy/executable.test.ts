import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { allowsWorkBuddyNode, resolveWorkBuddyCommand } from './executable.ts';
test('国内版执行器校验产品和后台开关，清除父进程密钥及注入参数', () => {
  const home = mkdtempSync(join(tmpdir(), 'fish-wb-command-'));
  const product = join(home, 'resources/app.asar.unpacked/cli/product.json');
  mkdirSync(join(home, 'resources/app.asar.unpacked/cli'), { recursive: true });
  const exe = join(home, 'WorkBuddy.exe');
  const fuse = Buffer.concat([
    Buffer.alloc(1024 * 1024 - 10),
    Buffer.from('dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX'),
    Buffer.from([1, 1, 49]),
  ]);
  writeFileSync(exe, fuse);
  writeFileSync(
    product,
    JSON.stringify({ endpoint: 'https://www.workbuddy.cn', authentication: { id: 'workbuddy-desktop' } }),
  );
  try {
    const cmd = resolveWorkBuddyCommand({
      DSH_PET_WORKBUDDY_PATH: exe,
      USERPROFILE: home,
      PATH: 'system-path',
      OPENAI_API_KEY: 'secret',
      CODEBUDDY_AUTH_TOKEN: 'secret',
      NODE_OPTIONS: '--import evil.mjs',
      ACC_PRODUCT_CONFIG_V3: 'other-product',
    });
    assert.equal(cmd.file, exe);
    assert.deepEqual(cmd.args, []);
    assert.equal(cmd.env.ELECTRON_RUN_AS_NODE, '1');
    for (const name of ['CODEBUDDY_AUTH_TOKEN', 'OPENAI_API_KEY', 'NODE_OPTIONS', 'ACC_PRODUCT_CONFIG_V3'])
      assert.equal(cmd.env[name], undefined);
    writeFileSync(
      product,
      JSON.stringify({ endpoint: 'https://www.workbuddy.ai', authentication: { id: 'workbuddy-desktop' } }),
    );
    assert.throws(() => resolveWorkBuddyCommand({ DSH_PET_WORKBUDDY_PATH: exe }), /不是受支持的国内版/u);
    fuse[fuse.length - 1] = 48;
    writeFileSync(exe, Buffer.concat([fuse, Buffer.from([0])]));
    assert.equal(allowsWorkBuddyNode(exe), false);
  } finally {
    assert.ok(resolve(home).startsWith(resolve(tmpdir()) + sep));
    rmSync(home, { recursive: true, force: true });
  }
});
