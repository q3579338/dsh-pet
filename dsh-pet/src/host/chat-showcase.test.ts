import assert from 'node:assert/strict';
import { test } from 'node:test';
import { correctActionTranscript, explicitShowcaseAction } from './chat-showcase.ts';
import { resolveChatAction } from './chat-action.ts';
const actions = ['展示天圆地方', '展示非洲之心'];
test('按当前角色动作纠正真实流式识别出现的两个专名同音词', () => {
  assert.equal(correctActionTranscript('请展示天元地方给我看。', actions), '请展示天圆地方给我看。');
  assert.equal(correctActionTranscript('拿出一颗非洲之星给我看看。', actions), '拿出一颗非洲之心给我看看。');
  assert.equal(correctActionTranscript('能不能给我看看天元地方？', actions), '能不能给我看看天圆地方？');
});
test('没有对应动作、否定、普通知识问答、引用和旁人叙述保持原话', () => {
  assert.equal(correctActionTranscript('展示天元地方', ['吃西瓜']), '展示天元地方');
  for (const text of [
    '请别展示天元地方',
    '不要拿出非洲之星',
    '非洲之星是什么',
    '给我介绍非洲之星的历史',
    '展示非洲之星的照片',
    '我拿出非洲之星给你看',
    '她展示天元地方',
    '刚才展示了天元地方',
    '他说“展示天元地方”',
  ])
    assert.equal(correctActionTranscript(text, actions), text);
});
test('分句独立、保留标点和正常用词，不扩展成全局替换或重复删除', () => {
  assert.equal(correctActionTranscript('别拿出非洲之星，展示天元地方。', actions), '别拿出非洲之星，展示天圆地方。');
  const text = '非洲之星是一颗钻石，今天想聊聊新闻。';
  assert.equal(correctActionTranscript(text, actions), text);
  assert.equal(correctActionTranscript('请展示天圆地方给我看。', actions), '请展示天圆地方给我看。');
});

test('文字与语音明确展示藏品时，漏标记或错误标记不再只留旧动作', () => {
  for (const reply of ['非洲之心登场～', '非洲之心登场～\n[动作:展示天圆地方]', '非洲之心登场～\n[动作:不存在]']) {
    const result = resolveChatAction(reply, actions, '拿出一颗非洲之心给我看看');
    assert.equal(result.action, '展示非洲之心');
    assert.equal(result.text, '非洲之心登场～');
  }
  assert.equal(resolveChatAction('好呀', actions, '请展示天圆地方给我看').action, '展示天圆地方');
  assert.equal(resolveChatAction('好呀', [], '请展示天圆地方给我看').action, undefined);
  assert.equal(resolveChatAction('好呀', actions, '非洲之心是什么').action, undefined);
  assert.equal(resolveChatAction('好呀\n[动作:展示天圆地方]', actions, '聊点什么').action, '展示天圆地方');
  for (const text of ['别拿出非洲之心', '展示非洲之心的图片', '她展示天圆地方', '他说“展示天圆地方”'])
    assert.equal(explicitShowcaseAction(text, actions), undefined);
});
