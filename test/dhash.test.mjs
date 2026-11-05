import test from 'node:test';
import assert from 'node:assert/strict';

import { dHash, hashDistance } from '../src/cuts.js';

/**
 * dHash：回答「**结构**是不是同一张画面」。
 *
 * 解决一镜到底的素材 —— 雨点/树叶/卷云一直在动，HSV 平均分 8~12 过得了
 * dupMin，但 64 bit 结构一位没变，那种帧拼进图里只是白占格子。
 *
 * 注意判据方向：dHash 是「左比右亮 → 1」。梯度递增的画面得到全 0，
 * 递减的得到全 1 —— 写用例时别按直觉反了。
 */

/** 用 V 通道造一张 64×36 的 HSV 网格（dHash 只看 V）。 */
function grid(fn) {
  const g = new Float32Array(64 * 36 * 3);
  for (let y = 0; y < 36; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const v = fn(x, y);
      const i = (y * 64 + x) * 3;
      g[i] = 0;
      g[i + 1] = 0;
      g[i + 2] = v;
    }
  }
  return g;
}

const ramp = (x) => (x / 63) * 255;

test('同一张画面距离为 0', () => {
  const a = grid(ramp);
  assert.equal(hashDistance(dHash(a), dHash(a)), 0);
});

test('整体提亮/压暗不改结构', () => {
  const dim = grid((x) => ramp(x) * 0.5);
  const bright = grid((x) => Math.min(255, ramp(x) * 1.5));
  assert.ok(hashDistance(dHash(dim), dHash(bright)) <= 2, '只改亮度时结构哈希应该基本不动');
});

test('叠一层小噪声仍是同一画面（一镜到底的雨/树叶）', () => {
  const clean = grid(ramp);
  let seed = 7;
  const noisy = grid((x) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return Math.max(0, Math.min(255, ramp(x) + (seed % 11) - 5));
  });
  assert.ok(hashDistance(dHash(clean), dHash(noisy)) <= 2, '细粒度噪声不该翻转结构位');
});

test('竖条和你横条是两种结构', () => {
  const verticalBars = grid((x) => (x % 2 ? 255 : 0));
  const horizontalBars = grid((x, y) => (y % 2 ? 255 : 0));
  assert.ok(hashDistance(dHash(verticalBars), dHash(horizontalBars)) > 20);
});

test('两张不同的纹理能分开', () => {
  const a = grid((x, y) => ((x * 7 + y * 13) % 251));
  const b = grid((x, y) => ((x * 13 + y * 7) % 241));
  assert.ok(hashDistance(dHash(a), dHash(b)) > 10);
});

test('缺一边时返回 64（没法比较不能当成一模一样）', () => {
  assert.equal(hashDistance(null, dHash(grid(ramp))), 64);
  assert.equal(hashDistance(dHash(grid(ramp)), undefined), 64);
  assert.equal(hashDistance(null, null), 64);
});

test('out 缓冲可以复用，结果一致', () => {
  const a = grid((x, y) => ((x * 7 + y * 13) % 251));
  const b = grid((x, y) => ((x * 13 + y * 7) % 241));
  const buf = new Uint8Array(8);
  const h1 = Array.from(dHash(a, buf));
  const h2 = Array.from(dHash(b, buf));
  const h3 = Array.from(dHash(a, buf));
  assert.deepEqual(h1, h3, '复用缓冲不能串味');
  assert.notDeepEqual(h1, h2);
});
