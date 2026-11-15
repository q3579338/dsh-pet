import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firstSpeechPart, speechParts } from './speech-parts.ts';

test('流未结束时只预热完整首句，播放分句命中同一段', () => {
  assert.equal(firstSpeechPart('我现在就来陪你'), undefined);
  const prefix = '我现在就来陪着你。';
  assert.equal(firstSpeechPart(prefix + '后面还没写完'), prefix);
  assert.equal(speechParts(prefix + '后面也会慢慢说完。')[0], prefix);
});

test('长回复分段后保留正文和标点，每次合成保持在服务长度限制内', () => {
  const text = '鱼'.repeat(119) + '。第二句也有完整的内容。';
  const parts = speechParts(text);
  assert.equal(parts.join(''), text);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 100));
});

test('不切断 emoji，纯空白不生成音频请求', () => {
  const text = '鱼'.repeat(99) + '🐳小鲸鱼来啦！';
  assert.equal(speechParts(text).join(''), text);
  assert.ok(speechParts(text).every((part) => !/[\uD800-\uDBFF]$/u.test(part)));
  assert.deepEqual(speechParts(' \n '), []);
});
