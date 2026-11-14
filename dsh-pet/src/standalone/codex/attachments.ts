/**
 * Codex 桌面版的本地图片附件：延用原版 sha256 引用与取图路由。
 * 图片解码由 Electron 提供；只接受用户显式附上的图片，不读取任意路径。
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { imageTypeOf } from '../../host/http.ts';
import type { PetImageRef, PetImageSink } from '../../host/image-attachment.ts';
import { codexRecord } from './client.ts';

/** 与原图入参的体积边界保持一致，另限制解码后像素。 */
const MAX_BYTES = 675_000;
const MAX_PIXELS = 32 * 1024 * 1024;
const ID = /^sha256:([a-f0-9]{64})$/;

/** 只按严格内容哈希拼接路径，不接受文件名和相对路径。 */
function imagePath(home: string, id: unknown): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error('大肥鱼图片引用无效。');
  return join(home, 'dsh-pet', 'attachments', id.slice(7));
}

/** 保存前由真实解码器检查文件有效性和尺寸，坏图不能伪装成已保存。 */
export function createCodexAttachments(
  home: string,
  inspect: (bytes: Uint8Array) => { width: number; height: number } | undefined,
): PetImageSink {
  return {
    imageLimits: { maxImageBytes: MAX_BYTES },
    imageHostPath(ref) {
      return imagePath(home, ref.attachmentId);
    },
    async saveImages(inputs) {
      if (inputs.length !== 1) throw new Error('每次只支持附一张图片。');
      const refs: PetImageRef[] = [];
      for (const input of inputs) {
        const buffer = Buffer.from(input.data);
        if (!buffer.length || buffer.length > MAX_BYTES || imageTypeOf(buffer, buffer.length) !== input.mediaType)
          throw new Error('图片格式或大小不受支持。');
        const size = inspect(buffer);
        if (!size || size.width <= 0 || size.height <= 0 || size.width * size.height > MAX_PIXELS)
          throw new Error('图片无法解码或像素过大。');
        const id = 'sha256:' + createHash('sha256').update(buffer).digest('hex');
        const path = imagePath(home, id);
        await mkdir(join(home, 'dsh-pet', 'attachments'), { recursive: true, mode: 0o700 });
        try {
          await writeFile(path, buffer, { flag: 'wx', mode: 0o600 });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        refs.push({ attachmentId: id, mediaType: input.mediaType, bytes: buffer.length, ...size });
      }
      return refs;
    },
  };
}

/** 将已保存、哈希一致的当前轮附件变成 Codex 官方 image 输入。 */
export function codexImageUrl(home: string, ref: unknown): string {
  const attachment = codexRecord(ref);
  const path = imagePath(home, attachment.attachmentId);
  if (!existsSync(path)) throw new Error('找不到本轮附图，请重新添加。');
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > MAX_BYTES) throw new Error('大肥鱼图片附件不可用。');
  const buffer = readFileSync(path);
  const type = imageTypeOf(buffer, buffer.length);
  const id = 'sha256:' + createHash('sha256').update(buffer).digest('hex');
  if (!type || id !== attachment.attachmentId || type !== attachment.mediaType) throw new Error('大肥鱼图片校验失败。');
  return `data:${type};base64,${buffer.toString('base64')}`;
}
