import test from 'node:test';
import assert from 'node:assert/strict';

import { readTuning } from '../src/tuning.js';
import { DEFAULT_HOTWORDS } from '../src/hotwords.js';

/**
 * asr 与 crop 两段配置的校验。
 *
 * 两段都遵循同一条规矩：**写错了不能让功能消失**，退回默认 + 留 warning；
 * 但「用户明确说不要」（false / 空数组）必须能真的关掉。
 */

const ENV = { DSH_HOME: '/tmp/dsh-home' };
const readJson = (obj) => () => JSON.stringify(obj);
const missing = () => { const e = new Error('nope'); e.code = 'ENOENT'; throw e; };

test('不写 asr 段 → 内置术语表（null 表示走默认）', () => {
  const t = readTuning({ env: ENV, readFile: missing });
  assert.deepEqual(t.asr, { hotwords: null, fixes: null, autoFix: true });
  assert.deepEqual(t.crop, {});
});

test('asr.hotwords 接受数组与逗号串', () => {
  const a = readTuning({ env: ENV, readFile: readJson({ asr: { hotwords: ['材质', ' 蓝图 '] } }) });
  assert.deepEqual(a.asr.hotwords, ['材质', '蓝图']);

  const b = readTuning({ env: ENV, readFile: readJson({ asr: { hotwords: '材质, 蓝图，光照' } }) });
  assert.deepEqual(b.asr.hotwords, ['材质', '蓝图', '光照']);
});

test('asr.hotwords: false 是关掉，不是用默认', () => {
  const t = readTuning({ env: ENV, readFile: readJson({ asr: { hotwords: false } }) });
  assert.deepEqual(t.asr.hotwords, []);
  assert.notDeepEqual(t.asr.hotwords, DEFAULT_HOTWORDS);
});

test('asr.fixes 与内置表合并；false 才是整个关掉', () => {
  const merged = readTuning({ env: ENV, readFile: readJson({ asr: { fixes: { 测试错: '测试对' } } }) });
  assert.equal(merged.asr.fixes['测试错'], '测试对');

  const off = readTuning({ env: ENV, readFile: readJson({ asr: { fixes: false } }) });
  assert.equal(off.asr.fixes, false, 'false 要原样传下去，折成 {} 会被当成合并');
});

test('asr 类型写错 → 退回默认并留 warning', () => {
  const t = readTuning({ env: ENV, readFile: readJson({ asr: { hotwords: 42, autoFix: 'yes' } }) });
  assert.equal(t.asr.hotwords, null);
  assert.equal(t.asr.autoFix, true);
  assert.ok(t.warnings.some((w) => w.includes('asr.hotwords')));
  assert.ok(t.warnings.some((w) => w.includes('asr.autoFix')));
});

test('crop 段只收用户真填的键', () => {
  const t = readTuning({
    env: ENV,
    readFile: readJson({ crop: { zoom: false, minArea: 0.01, pad: 0.4 } }),
  });
  assert.deepEqual(t.crop, { cropZoom: false, cropMinArea: 0.01, cropPad: 0.4 });
  assert.equal('cropMaxArea' in t.crop, false, '没填的键不该出现在覆盖里');
});

test('crop 越界 → 不写进覆盖，并留 warning', () => {
  const t = readTuning({ env: ENV, readFile: readJson({ crop: { minArea: 9, maxArea: 0.01 } }) });
  assert.deepEqual(t.crop, {});
  assert.ok(t.warnings.some((w) => w.includes('crop.minArea')));
  assert.ok(t.warnings.some((w) => w.includes('crop.maxArea')));
});
