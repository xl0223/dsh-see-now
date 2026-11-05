import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createScorer, scorePair, scorePairDetail } from '../src/cuts.js';

/**
 * 局部读数（peak / hot）。
 *
 * 这是「双尺度」的第二把尺子：整屏平均分对「改了一个数值」几乎失明（0.1~0.5 分），
 * 而积分门槛是 144 —— 按这个分数要 40 秒才出帧。peak/hot 必须在**不改变原分数**
 * 的前提下把这件事读出来，否则老行为会被悄悄改掉。
 */

/** 确定性伪随机：测试不能靠 Math.random，失败要可复现。 */
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

test('scorePairDetail 的 score 与 scorePair 逐位相同', () => {
  const rnd = lcg(42);
  const n = 64 * 36 * 3;
  for (let round = 0; round < 20; round += 1) {
    const a = new Float32Array(n);
    const b = new Float32Array(n);
    for (let i = 0; i < n; i += 1) {
      a[i] = rnd() * 255;
      b[i] = rnd() * 255;
    }
    assert.equal(scorePairDetail(a, b).score, scorePair(a, b),
      '新读数不许动老的分数，一个 bit 都不行');
  }
});

test('peak 抓单格最大差，hot 数超门槛的格数', () => {
  const n = 64 * 36 * 3;
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  // 三个格子从黑变白：S=0 时色相不参与，只有 V 的 255 差 / 3
  for (const c of [0, 1, 2]) b[c * 3 + 2] = 255;
  const d = scorePairDetail(a, b, { hotTau: 24 });
  assert.equal(d.peak, 85, 'V 差 255 三通道平均后是 85');
  assert.equal(d.hot, 3);
  assert.ok(d.score < 1, `整屏平均应该很小，实际 ${d.score}`);
});

test('createScorer 把 peak/hot 一起带出来，且不改分数口径', () => {
  const w = 320;
  const h = 180;
  const scorer = createScorer({ width: w, height: h });
  const f1 = Buffer.alloc(w * h * 3, 0);
  const f2 = Buffer.alloc(w * h * 3, 0);
  // 中间一块 30×30 的白
  for (let y = 70; y < 100; y += 1) {
    for (let x = 140; x < 170; x += 1) {
      const p = (y * w + x) * 3;
      f2[p] = 255;
      f2[p + 1] = 255;
      f2[p + 2] = 255;
    }
  }
  scorer(f1);
  const r = scorer(f2);
  assert.equal(r.peak, 85);
  assert.ok(r.hot >= 20, `30×30 的块应该铺开不少格，实际 hot=${r.hot}`);
  assert.ok(r.score < 12, `整屏平均仍然很小，实际 ${r.score}`);
});
