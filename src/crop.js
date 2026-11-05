/**
 * crop.js — 从「刚才变了的那一块」裁一张特写出来。
 *
 * ## 为什么需要它
 *
 * 797×450 的画布里塞 4 帧，每帧只剩 ~398×225。这个尺寸看界面整体够用，
 * 但看**游戏引擎的属性面板、代码、数值、报错行**全是糊的 —— 而这类内容
 * 恰好是「局部微变」：整屏不动，只有一小块字符换了。
 *
 * `mcStats()` 早就在返回 `box`（变化格的包围矩形，64×36 网格坐标），但过去
 * 它只被 `noteChange()` 拿去写变化日志。这里把它接到出图上：变化区域只占画布
 * 一小块时，以它为中心裁一块出来铺进格子，等效于自动放大。
 *
 * ## 边界
 *
 * - **太小不裁**：一两格的变化多半是光标或插入符，裁出来是噪点放大。
 * - **太大不裁**：超过半屏就没有「特写」的意义，还得承担裁切后的画质损失。
 * - **保住上下文的余地**：向外扩 `pad`（按区域尺寸的比例），不然模型只看到
 *   「一段文字」而不知道它在哪个窗口。
 * - 裁切窗按**目标格子的宽高比**扩展，避免再被 `coverIntoAt` 二次裁边。
 */

import { SCAN_W, SCAN_H } from './cuts.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * 把网格坐标的变化框换算成源图像素矩形，并按特写规则收放。
 *
 * @param {{x0:number,y0:number,x1:number,y1:number}|null} box 64×36 网格坐标（含端点）
 * @param {number} srcW 源帧宽（像素）
 * @param {number} srcH 源帧高（像素）
 * @param {number} cellW 目标格子宽（像素）
 * @param {number} cellH 目标格子高（像素）
 * @param {{minArea?:number,maxArea?:number,pad?:number,minSide?:number}} [opts]
 * @returns {{x:number,y:number,w:number,h:number,area:number}|null} 像素矩形，或 null = 不裁
 */
export function cropPlan(box, srcW, srcH, cellW, cellH, opts = {}) {
  if (!box || !(srcW > 0) || !(srcH > 0) || !(cellW > 0) || !(cellH > 0)) return null;
  const minArea = opts.minArea ?? 0.02;
  const maxArea = opts.maxArea ?? 0.5;
  const pad = opts.pad ?? 0.25;
  const minSide = opts.minSide ?? 0.25;

  // 网格 → 像素：第 gx 格覆盖 [gx/SCAN_W, (gx+1)/SCAN_W) 这一段
  const bx = (box.x0 / SCAN_W) * srcW;
  const by = (box.y0 / SCAN_H) * srcH;
  let bw = ((box.x1 - box.x0 + 1) / SCAN_W) * srcW;
  let bh = ((box.y1 - box.y0 + 1) / SCAN_H) * srcH;
  if (!(bw > 0) || !(bh > 0)) return null;

  const area0 = (bw * bh) / (srcW * srcH);
  // 太小 = 光标/插入符级别，放大到满格只会变成噪点
  if (area0 < minArea) return null;
  // 太大 = 接近整屏，本来就不糊
  if (area0 > maxArea) return null;

  // 向外扩一圈上下文（按区域自身尺寸，不是整幅）
  bw *= 1 + pad * 2;
  bh *= 1 + pad * 2;
  // 太窄/太高的东西（一行字、一条侧栏）先把短边撑起来，否则特写里全是留白
  const minW = srcW * minSide;
  const minH = srcH * minSide;
  if (bw < minW) bw = minW;
  if (bh < minH) bh = minH;

  // 按目标格子的宽高比修正：宁可多裁一点上下文，也不要让 coverIntoAt 再裁一刀
  const target = cellW / cellH;
  if (bw / bh > target) {
    const want = bw / target;
    if (want <= srcH) bh = want; else { bh = srcH; bw = srcH * target; }
  } else {
    const want = bh * target;
    if (want <= srcW) bw = want; else { bw = srcW; bh = srcW / target; }
  }

  bw = Math.min(srcW, Math.round(bw));
  bh = Math.min(srcH, Math.round(bh));
  if (bw < 8 || bh < 8) return null;

  // 以变化框中心为准，夹进源图
  const cx = bx + ((box.x1 - box.x0 + 1) / SCAN_W) * srcW / 2;
  const cy = by + ((box.y1 - box.y0 + 1) / SCAN_H) * srcH / 2;
  const x = clamp(Math.round(cx - bw / 2), 0, srcW - bw);
  const y = clamp(Math.round(cy - bh / 2), 0, srcH - bh);

  // 裁完几乎没变小就别裁了（白费一次拷贝，还丢了上下文）
  if (bw * bh >= srcW * srcH * 0.85) return null;
  return { x, y, w: bw, h: bh, area: (bw * bh) / (srcW * srcH) };
}

/**
 * 把源帧的一块拷成独立缓冲。
 *
 * 逐行 `copy` 而不是逐像素：块宽 400 × 3 字节 = 1200B，Node 的 `Buffer#copy`
 * 走的是 memmove。一张 4 帧图最多拷 4 次、每次 ~300KB，实测 0.4ms 量级，
 * 相对出图本身（40ms）可以忽略 —— 换来的好处是 `composePacked` 的契约一个字不改。
 *
 * @param {Buffer} src rgb24，行宽 `srcW`
 * @returns {{buf:Buffer,w:number,h:number}}
 */
export function cropFrame(src, srcW, srcH, rect) {
  const { x, y, w, h } = rect;
  if (!(w > 0) || !(h > 0)) throw new RangeError('cropFrame: empty rect');
  if (x < 0 || y < 0 || x + w > srcW || y + h > srcH) {
    throw new RangeError(`cropFrame: rect out of bounds ${x},${y} ${w}x${h} in ${srcW}x${srcH}`);
  }
  const stride = srcW * 3;
  const out = Buffer.allocUnsafe(w * h * 3);
  for (let row = 0; row < h; row += 1) {
    const s = (y + row) * stride + x * 3;
    src.copy(out, row * w * 3, s, s + w * 3);
  }
  return { buf: out, w, h };
}
