import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cropFrame, cropPlan } from '../src/crop.js';

/**
 * 特写裁剪：把「刚才变了的那一块」按原分辨率铺进格子。
 *
 * 为什么值得为它写测试：`mcRect` 从 `cuts.js` 一路传到出图，中间任何一环算错
 * （网格坐标当像素用、宽高比没对齐）都会让模型看到一块**错位**的画面 ——
 * 而错位的图比没有图更糟，模型会照着它编。
 */

const W = 798;
const H = 450;
const CELL_W = 398;
const CELL_H = 224;

test('没有变化框时一律不裁', () => {
  assert.equal(cropPlan(null, W, H, CELL_W, CELL_H), null);
  assert.equal(cropPlan(undefined, W, H, CELL_W, CELL_H), null);
  assert.equal(cropPlan({ x0: 1, y0: 1, x1: 2, y1: 2 }, 0, 0, CELL_W, CELL_H), null);
});

test('光标级的小框不裁：放大一两个格只会变成噪点', () => {
  // 1×1 网格格 = 12×12 像素，面积 0.04%
  assert.equal(cropPlan({ x0: 10, y0: 10, x1: 10, y1: 10 }, W, H, CELL_W, CELL_H), null);
});

test('铺开半屏以上的框不裁：本来就不糊，还白丢上下文', () => {
  assert.equal(cropPlan({ x0: 0, y0: 0, x1: 63, y1: 35 }, W, H, CELL_W, CELL_H), null);
});

test('中等区域裁成特写，宽高比与目标格对齐', () => {
  const r = cropPlan({ x0: 20, y0: 10, x1: 29, y1: 17 }, W, H, CELL_W, CELL_H);
  assert.ok(r, '这个尺寸应该裁');
  assert.ok(r.w < W * 0.6, `应明显小于整帧，实际 ${r.w}`);
  const target = CELL_W / CELL_H;
  assert.ok(Math.abs(r.w / r.h - target) < 0.02,
    `宽高比要对齐目标格：${(r.w / r.h).toFixed(3)} vs ${target.toFixed(3)}`);
  assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.w <= W && r.y + r.h <= H, '不能越界');
});

test('贴边的框会被夹进画面内，而不是越界', () => {
  // 13×10 格 ≈ 162×125 像素（5.6% 面积，过得了 minArea 那道闸）
  const r = cropPlan({ x0: 0, y0: 0, x1: 12, y1: 9 }, W, H, CELL_W, CELL_H);
  assert.ok(r);
  assert.equal(r.x, 0, '左上角的框，裁切窗应该贴住左边界');
  assert.equal(r.y, 0);
  assert.ok(r.x + r.w <= W && r.y + r.h <= H);
});

test('cropFrame 逐字节拷对位置（不是只拷对了尺寸）', () => {
  const sw = 8;
  const sh = 6;
  const src = Buffer.alloc(sw * sh * 3);
  for (let y = 0; y < sh; y += 1) {
    for (let x = 0; x < sw; x += 1) {
      const p = (y * sw + x) * 3;
      src[p] = x;
      src[p + 1] = y;
      src[p + 2] = 100 + x;
    }
  }
  const out = cropFrame(src, sw, sh, { x: 2, y: 3, w: 4, h: 2 });
  assert.equal(out.w, 4);
  assert.equal(out.h, 2);
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 4; x += 1) {
      const p = (y * 4 + x) * 3;
      assert.equal(out.buf[p], x + 2);
      assert.equal(out.buf[p + 1], y + 3);
      assert.equal(out.buf[p + 2], 102 + x);
    }
  }
});

test('越界矩形直接报错，绝不静默裁短', () => {
  const src = Buffer.alloc(8 * 6 * 3);
  assert.throws(() => cropFrame(src, 8, 6, { x: 6, y: 0, w: 4, h: 2 }), /out of bounds/);
});
