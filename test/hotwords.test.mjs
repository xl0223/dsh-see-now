import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFixes, DEFAULT_FIXES, DEFAULT_HOTWORDS, hotwordString, MAX_HOTWORDS, resolveAsrTerms,
} from '../src/hotwords.js';

/**
 * 术语表：热词治本（让解码器往这些词上靠）、错词表治标（转写回来再修）。
 *
 * 错词表的代价是**把对的改错** —— 那比不修更糟，模型会照着错的内容推理。
 * 所以这里的用例一半在验证「该修的修了」，一半在验证「不该动的没动」。
 */

test('常见同音错写被修掉', () => {
  assert.equal(applyFixes('这个才质要用蓝兔'), '这个材质要用蓝图');
  assert.equal(applyFixes('实力化一个组件'), '实例化一个组件');
  assert.equal(applyFixes('关键针打好了'), '关键帧打好了');
  assert.equal(applyFixes('调一下光找'), '调一下光照');
});

test('长词优先：不会被短词切碎', () => {
  assert.equal(applyFixes('渲染管到有点重'), '渲染管线有点重');
});

test('正确写法一个都不动', () => {
  const right = [
    '骨架', '网格', '材质球', '预制体', '骨骼动画', '蒙皮', '法线',
    '关掉这个开关', '实力', '光', '位', '烘焙', '贴图', '着色器',
  ];
  for (const s of right) assert.equal(applyFixes(s), s, '不该改：' + s);
});

test('传空表 = 关掉；传 null 也不炸', () => {
  assert.equal(applyFixes('这个才质很好', {}), '这个才质很好');
  assert.equal(applyFixes(null), '');
  assert.equal(applyFixes(undefined), '');
});

test('热词串：去重、去空白、按上限截断', () => {
  assert.equal(hotwordString(['材质', ' 材质 ', '蓝图']), '材质,蓝图');
  assert.equal(hotwordString('材质, 蓝图，光照'), '材质,蓝图,光照');
  assert.equal(hotwordString([]), '');
  const many = Array.from({ length: MAX_HOTWORDS + 10 }, (_, i) => '词' + i);
  assert.equal(hotwordString(many).split(',').length, MAX_HOTWORDS);
});

test('resolveAsrTerms：不写用默认、空数组是明确关掉、false 也关掉', () => {
  const dflt = resolveAsrTerms(null);
  assert.equal(dflt.hotwords, DEFAULT_HOTWORDS);
  assert.equal(dflt.fixes, DEFAULT_FIXES);

  assert.deepEqual(resolveAsrTerms({ hotwords: [] }).hotwords, []);
  assert.deepEqual(resolveAsrTerms({ hotwords: false }).hotwords, []);
  assert.deepEqual(resolveAsrTerms({ fixes: false }).fixes, {});

  const merged = resolveAsrTerms({ fixes: { 测试错: '测试对' } });
  assert.equal(merged.fixes['测试错'], '测试对');
  assert.equal(merged.fixes['才质'], '材质', '内置那些不能被冲掉');
});
