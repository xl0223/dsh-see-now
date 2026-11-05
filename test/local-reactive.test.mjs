import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createPipeline } from '../src/pipeline.js';

/**
 * 端到端：局部微变到底能不能提前出帧。
 *
 * 场景就是用户真实遇到的那个 —— 屏幕静止，改了一个数值（一小块变亮），
 * 然后继续静止。老逻辑只有积分，而积分对「一次性」的变化永远攒不满。
 */

const W = 320;
const H = 180;
const FPS = 12;

function baseFrame() {
  return Buffer.alloc(W * H * 3, 40);
}

function paint(buf, x0, y0, w, h, v) {
  for (let y = y0; y < y0 + h; y += 1) {
    for (let x = x0; x < x0 + w; x += 1) {
      const p = (y * W + x) * 3;
      buf[p] = v;
      buf[p + 1] = v;
      buf[p + 2] = v;
    }
  }
}

/** 跑一段「静止 → 第 mutateAt 帧改一块 → 继续静止」。 */
function run({ extra = {}, mutateAt = 20, frames = 40 } = {}) {
  const p = createPipeline({ width: W, height: H, fps: FPS, ...extra });
  const base = baseFrame();
  for (let i = 0; i < frames; i += 1) {
    const f = Buffer.from(base);
    if (i === mutateAt) paint(f, 140, 70, 60, 40, 240);
    p.push({ t: i / FPS, buf: f });
  }
  return p;
}

test('局部强变化走一次性出口，不等积分', () => {
  const off = run({ extra: { localEvent: 0, cropZoom: false } });
  const on = run({ extra: { localEvent: 60, cropZoom: false } });
  assert.equal(off.stats.locals, 0, '关掉时不该有 local 帧');
  assert.ok(on.stats.locals >= 1, `开起来应该靠 local 留帧，实际 ${on.stats.locals}`);
});

test('局部加成让积分更早攒满（同一段素材，出帧更早）', () => {
  // 连续 20 帧都有小幅局部变化：靠 localBoost 推进积分
  const mk = (boost) => {
    const p = createPipeline({
      width: W, height: H, fps: FPS, localEvent: 0, cropZoom: false,
      localBoost: boost, localPeakMin: 40, localMinCells: 4,
      integralSeconds: 3,
    });
    const base = baseFrame();
    for (let i = 0; i < 48; i += 1) {
      const f = Buffer.from(base);
      // 每帧换一小块内容（模拟持续的小改动）：固定高对比度，让 localSignal 恒有值，
      // 这样比的是「加成开不开」，而不是「这一帧亮度够不够」
      paint(f, 140 + (i % 10) * 4, 70, 24, 16, 240);
      p.push({ t: i / FPS, buf: f });
    }
    return p;
  };
  const slow = mk(0);
  const fast = mk(1.5);
  assert.ok(fast.stats.kept > slow.stats.kept,
    `加成的应该留得更多：slow=${slow.stats.kept} fast=${fast.stats.kept}`);
});

test('出图时把特写倍数写进清单元数据', () => {
  const p = run({ extra: { localEvent: 60, cropZoom: true } });
  const { sheets } = p.finish();
  const withZoom = sheets.flatMap((s) => s.frames ?? []).filter((f) => typeof f.zoom === 'number');
  assert.ok(withZoom.length > 0, '至少有一帧该是特写');
  assert.ok(withZoom.every((f) => f.zoom >= 1), '倍数不可能小于 1');
});

test('cropZoom:false 时退回到整帧缩放（老行为）', () => {
  const p = run({ extra: { localEvent: 60, cropZoom: false } });
  const { sheets } = p.finish();
  const zooms = sheets.flatMap((s) => s.frames ?? []).map((f) => f.zoom);
  assert.ok(zooms.every((z) => z === null || z === undefined), '关掉后不该有任何特写');
});
