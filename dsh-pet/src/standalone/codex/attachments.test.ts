import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCodexAttachments, codexImageUrl } from './attachments.ts';
import { parseRequest } from '../ai-provider/request.ts';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=',
  'base64',
);

test('Codex attachments are content-addressed, bounded and limited to explicit current-turn input', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-fish-image-'));
  try {
    const sink = createCodexAttachments(root, () => ({ width: 1, height: 1 }));
    const [ref] = await sink.saveImages([{ data: png, mediaType: 'image/png' }]);
    assert.match(ref.attachmentId, /^sha256:[a-f0-9]{64}$/);
    assert.equal(codexImageUrl(root, ref), 'data:image/png;base64,' + png.toString('base64'));
    const options = {
      provider: 'standalone',
      model: 'default',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '看图' },
            { type: 'image', attachment: ref },
          ],
        },
      ],
    };
    assert.equal(parseRequest(options, 'default').request.images, undefined, '普通 API 的既有文本路径保持不变');
    assert.deepEqual(parseRequest(options, 'default', (attachment) => codexImageUrl(root, attachment)).request.images, [
      codexImageUrl(root, ref),
    ]);
    assert.throws(() => codexImageUrl(root, { ...ref, attachmentId: '../../private-file' }), /无效/);
    await assert.rejects(sink.saveImages([{ data: png, mediaType: 'image/jpeg' }]), /格式/);
    await assert.rejects(
      createCodexAttachments(root, () => undefined).saveImages([{ data: png, mediaType: 'image/png' }]),
      /解码/,
    );
    await assert.rejects(
      createCodexAttachments(root, () => ({ width: 100000, height: 100000 })).saveImages([
        { data: png, mediaType: 'image/png' },
      ]),
      /像素/,
    );
    await writeFile(sink.imageHostPath!(ref)!, Buffer.from('tampered'));
    assert.throws(() => codexImageUrl(root, ref), /校验/);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5 });
  }
});
