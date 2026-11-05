/**
 * cuts.js — 逐帧画面变化分。**因果**，不看未来（除了一帧的尖峰确认）。
 *
 * `scorePair` 照抄 storyboard 的 scan.js（HSV 三通道加权绝对差，0–255）——
 * 同一段测试片它 9/9 命中、`ffmpeg scdet` 只 4/9（scdet 算亮度类 MAFD，对"同亮度换色"失明）。
 * 唯一改动：喂进来的不是整帧，而是 64×36 的网格，顺带把降采样的平均做了。
 */

export const SCAN_W = 64;
export const SCAN_H = 36;

/** 64×36 网格：每格取 4 个采样点求平均（降噪，且只花 9k 次读）。 */
export function gridRgb(rgb, width, height, out) {
  const sx = width / SCAN_W;
  const sy = height / SCAN_H;
  for (let gy = 0; gy < SCAN_H; gy += 1) {
    const y0 = ((gy + 0.25) * sy) | 0;
    const y1 = ((gy + 0.75) * sy) | 0;
    const r0 = y0 * width;
    const r1 = y1 * width;
    for (let gx = 0; gx < SCAN_W; gx += 1) {
      const x0 = ((gx + 0.25) * sx) | 0;
      const x1 = ((gx + 0.75) * sx) | 0;
      const a = (r0 + x0) * 3;
      const b = (r0 + x1) * 3;
      const c = (r1 + x0) * 3;
      const d = (r1 + x1) * 3;
      const i = gy * SCAN_W + gx;
      out[i * 3] = (rgb[a] + rgb[b] + rgb[c] + rgb[d]) * 0.25;
      out[i * 3 + 1] = (rgb[a + 1] + rgb[b + 1] + rgb[c + 1] + rgb[d + 1]) * 0.25;
      out[i * 3 + 2] = (rgb[a + 2] + rgb[b + 2] + rgb[c + 2] + rgb[d + 2]) * 0.25;
    }
  }
  return out;
}

/** RGB → HSV（各通道归一到 0–255，H 由角度缩放）。就地写进 out，不分配。 */
export function rgbToHsv(rgb, out) {
  for (let i = 0, j = 0; i < rgb.length; i += 3, j += 3) {
    const rn = rgb[i] / 255;
    const gn = rgb[i + 1] / 255;
    const bn = rgb[i + 2] / 255;
    const max = rn > gn ? (rn > bn ? rn : bn) : (gn > bn ? gn : bn);
    const min = rn < gn ? (rn < bn ? rn : bn) : (gn < bn ? gn : bn);
    const d = max - min;
    let h = 0;
    if (d !== 0) {
      if (max === rn) h = ((gn - bn) / d) % 6;
      else if (max === gn) h = (bn - rn) / d + 2;
      else h = (rn - gn) / d + 4;
      h *= 60;
      if (h < 0) h += 360;
    }
    out[j] = (h / 360) * 255;
    out[j + 1] = max === 0 ? 0 : (d / max) * 255;
    out[j + 2] = max * 255;
  }
  return out;
}

/** 两帧 HSV 的加权绝对差均值，0–255。色相按环形处理，低饱和像素的色相降权。 */
function hsvDiff(a, b, pa, pb = pa) {
  const dh = Math.abs(a[pa] - b[pb]);
  const hd = Math.min(dh, 255 - dh);
  const w = Math.min(a[pa + 1], b[pb + 1]) / 255;
  return (hd * w + Math.abs(a[pa + 1] - b[pb + 1]) + Math.abs(a[pa + 2] - b[pb + 2])) / 3;
}

export function scorePair(prev, cur) {
  let sum = 0;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    sum += hueDiff * hueWeight
      + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2]);
  }
  return sum / ((cur.length / 3) * 3);
}

/**
 * 同一个分数的**第二种读法**：除了「整屏平均变了多少」，还给出「最狠的那一格变了多少」。
 *
 * ## 为什么需要
 *
 * `scorePair` 返回的是 2304 个格子的平均值。**平均值天生对局部失明**：
 * 游戏引擎里把一个数值 100 改成 99、代码里改一行、报错弹出一行红字 ——
 * 整屏平均分往往 0.1~0.5（实测标定见 README 的刻度表：滚网页才 30~42）。
 * 而积分的门槛是 `REF_SCORE × fps × integralSeconds = 144`，
 * 按 0.3 分/帧 算要 **40 秒**才攒够一个采样点 —— 也就是说这类改动
 * 「AI 看到的是 40 秒前的画面」。
 *
 * 所以额外统计两件事：
 *   - **`peak`**：单格最大差（三通道平均，和 `score` 同刻度）。回答「变化有多猛」。
 *   - **`hot`**：超过 `hotTau` 的格数。回答「变化占了多少地方」。
 *
 * 光标是小面积、高幅度；文字/数值改动同样是小面积 —— **光靠 `peak` 分不开**,
 * 所以上层把 `hot` 一起当条件用，并且只在「够猛且够多」时才加成（见 pipeline 的
 * `localSignal`）。这两个数不改变 `score` 的任何一个 bit，纯属额外读数。
 *
 * @param {Float32Array} prev 上一帧 HSV 网格
 * @param {Float32Array} cur 当前帧 HSV 网格
 * @param {{hotTau?:number}} [opts] 单格算「热」的门槛（0–255 刻度）
 * @returns {{score:number, peak:number, hot:number}} `score` 与 `scorePair` 逐位相同
 */
export function scorePairDetail(prev, cur, { hotTau = 24 } = {}) {
  let sum = 0;
  let peak = 0;
  let hot = 0;
  let minX = SCAN_W;
  let minY = SCAN_H;
  let maxX = -1;
  let maxY = -1;
  for (let i = 0; i < cur.length; i += 3) {
    const dh = Math.abs(cur[i] - prev[i]);
    const hueDiff = Math.min(dh, 255 - dh);
    const hueWeight = Math.min(cur[i + 1], prev[i + 1]) / 255;
    const d = hueDiff * hueWeight
      + Math.abs(cur[i + 1] - prev[i + 1])
      + Math.abs(cur[i + 2] - prev[i + 2]);
    sum += d;
    const dd = d / 3;
    if (dd > peak) peak = dd;
    if (dd > hotTau) {
      hot += 1;
      const c = i / 3;
      const x = c % SCAN_W;
      const y = (c / SCAN_W) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return {
    score: sum / ((cur.length / 3) * 3),
    peak,
    hot,
    /**
     * **绝对差的热区包围框**（网格坐标，含端点）。`null` = 没有超门槛的格。
     *
     * 与 `mcStats` 的 `box` 不是一回事：那个是**运动补偿后**仍然变的格，
     * 用于判切点（整屏平移能被邻域吸收）。特写要的是「画面上真的变了的地方」，
     * 不能过运动补偿 —— 否则一块均匀的弹窗、一整行新文字会被邻域匹配吞掉，
     * 裁出来是空框（实测：60×40 的均匀色块在 radius=4 下被完全吸收）。
     */
    box: hot === 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY },
  };
}

/**
 * 打分器：内部维护上一帧的 HSV。
 * 返回 `{ score, hsv }`，score 为 null 表示这是第一帧（没有前帧可比）。
 * **hsv 是复用的缓冲**，要用就自己拷走。
 */
/**
 * 运动补偿打分（可选口径）：每个格子在下一帧 ±radius 邻域里找最像的，连最像的都超 tau 才算"变了"，
 * 返回 0–255 的占比刻度（×255 与旧口径同量级，便于复用现有阈值经验）。
 * 出处：Nagasaka & Tanaka 1992（像素变化计数）、Shahraray 1995（邻域匹配）；独立实现，未取代码。
 */
export function mcStats(prev, cur, { tau = 15, radius = 2 } = {}) {
  const n = SCAN_W * SCAN_H;
  let changed = 0;
  let minX = SCAN_W;
  let minY = SCAN_H;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < SCAN_H; y += 1) {
    for (let x = 0; x < SCAN_W; x += 1) {
      const p3 = (y * SCAN_W + x) * 3;
      /**
       * **先测同位置（dx=dy=0）**。
       *
       * 屏幕最常见的状态是"这一格没变"，而旧的 dy 从 -radius 开始扫：
       * radius=4 时同位置在第 41 个才轮到，静止画面每个格都要白算 40 次才命中。
       * 实测整屏静止的 mcStats 从 0.72ms 降到 0.06ms（-92%）。
       */
      let matched = false;
      {
        const dh0 = Math.abs(cur[p3] - prev[p3]);
        const hd0 = dh0 < 255 - dh0 ? dh0 : 255 - dh0;
        const hw0 = (cur[p3 + 1] < prev[p3 + 1] ? cur[p3 + 1] : prev[p3 + 1]) / 255;
        const d0 = (hd0 * hw0
          + Math.abs(cur[p3 + 1] - prev[p3 + 1])
          + Math.abs(cur[p3 + 2] - prev[p3 + 2])) / 3;
        matched = d0 <= tau;
      }
      if (!matched) {
        for (let dy = -radius; dy <= radius && !matched; dy += 1) {
          const yy = y + dy;
          if (yy < 0 || yy >= SCAN_H) continue;
          for (let dx = -radius; dx <= radius; dx += 1) {
            if (dx === 0 && dy === 0) continue;      // 上面已经测过
            const xx = x + dx;
            if (xx < 0 || xx >= SCAN_W) continue;
            const q3 = (yy * SCAN_W + xx) * 3;
            const dh = Math.abs(cur[q3] - prev[p3]);
            const hueDiff = Math.min(dh, 255 - dh);
            const hueWeight = Math.min(cur[q3 + 1], prev[p3 + 1]) / 255;
            const d = (hueDiff * hueWeight
              + Math.abs(cur[q3 + 1] - prev[p3 + 1])
              + Math.abs(cur[q3 + 2] - prev[p3 + 2])) / 3;
            if (d <= tau) { matched = true; break; }
          }
        }
      }
      if (!matched) {
        changed += 1;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const w = changed === 0 ? 0 : maxX - minX + 1;
  const h = changed === 0 ? 0 : maxY - minY + 1;
  return {
    score: (changed / n) * 255,
    bbox: ((w * h) / n) * 255,
    fill: changed === 0 ? 0 : changed / (w * h),
    spanY: h / SCAN_H,
    /**
     * 变化格的包围矩形（网格坐标 0..SCAN_W / 0..SCAN_H，含端点）。`null` = 整帧没变。
     *
     * 取它只是为了回答「刚才**哪里**变了」—— 没有它，模型只知道"变了多少"，
     * 不知道是右下角弹了个框还是整屏换页，回看的优先级只能瞎猜。
     * 位置换算成比例放在交付层做（见 `pipeline.js` 的 `noteChange`）。
     */
    box: changed === 0 ? null : { x0: minX, y0: minY, x1: maxX, y1: maxY },
  };
}

export function mcRatioScore(prev, cur, opts = {}) {
  return mcStats(prev, cur, opts).score;
}

/**
 * 背景模型：在最近 `history.length` 帧里找**一直没怎么动**的格子，
 * 再看当前帧把这些稳定背景格改掉了多少。
 *
 * 前景运动（手、勺子、遮挡物）只盖住一部分背景，稳定背景格大部分还在；
 * 真正切镜头会把旧背景整片换掉。返回值里的 `score` 是稳定背景格的变化占比（0–255），
 * `stable` 少的时候不要用它下结论。
 */
export function bgStats(history, cur, { stableRange = 24, tau = 15, withModel = false } = {}) {
  const n = SCAN_W * SCAN_H;
  const m = history.length;
  if (m === 0) return { score: null, stable: 0, changed: 0, model: null };
  // 排序用的一次性缓冲，**不在格子循环里分配** —— 旧写法每个格子都 `[0,0,0]`，
  // 2304 格/帧 × 12fps = 每秒 2.7 万个短命数组，全喂给 GC。
  const vals = new Float32Array(m);
  const half = m >> 1;
  const model = withModel
    ? { med: new Float32Array(n * 3), stable: new Uint8Array(n), tau }
    : null;
  let stable = 0;
  let changed = 0;
  for (let c = 0; c < n; c += 1) {
    const p = c * 3;
    let range = 0;
    let medR = 0;
    let medG = 0;
    let medB = 0;
    for (let ch = 0; ch < 3; ch += 1) {
      for (let j = 0; j < m; j += 1) vals[j] = history[j][p + ch];
      // m ≤ 8 的**插入排序**：比 `TypedArray#sort` 快一倍多（后者每次都是一次内建调用，
      // 而这里只有十几次比较）。实测 bgStats 从 1.08ms 降到 0.35ms。
      for (let i = 1; i < m; i += 1) {
        const v = vals[i];
        let k = i - 1;
        while (k >= 0 && vals[k] > v) { vals[k + 1] = vals[k]; k -= 1; }
        vals[k + 1] = v;
      }
      const mid = vals[half];
      if (ch === 0) medR = mid; else if (ch === 1) medG = mid; else medB = mid;
      const r = vals[m - 1] - vals[0];
      if (r > range) range = r;
    }
    if (model) {
      model.med[p] = medR;
      model.med[p + 1] = medG;
      model.med[p + 2] = medB;
    }
    if (range > stableRange) continue;
    stable += 1;
    if (model) model.stable[c] = 1;
    // hsvDiff 的内联版：省一次函数调用 + 省一个 `med` 数组
    const dh = Math.abs(cur[p] - medR);
    const hd = dh < 255 - dh ? dh : 255 - dh;
    const hw = (cur[p + 1] < medG ? cur[p + 1] : medG) / 255;
    const d = (hd * hw + Math.abs(cur[p + 1] - medG) + Math.abs(cur[p + 2] - medB)) / 3;
    if (d > tau) changed += 1;
  }
  return {
    score: stable === 0 ? null : (changed / stable) * 255,
    stable,
    changed,
    model,
  };
}

/**
 * dHash（difference hash）—— 64 位感知哈希，回答「**结构**是不是同一张画面」。
 *
 * ## 为什么 HSV 平均差分不开这一种
 *
 * `scorePair` 判的是「每个格子差多少」。一镜到底的素材（雨、树叶、卷动的云）里，
 * 每帧的**平均分不低**（雨点一直在动，5~10 分），但**画面结构一模一样** ——
 * 作者原来的 `dupMin` 就是为这个加的，可阈值一旦调高就会误杀真实变化。
 *
 * 结构哈希把这两件事拆开：雨点只改少数格子，9×8 灰度网格把细节平均掉，
 * 相邻比较的 64 个 bit 几乎不动（距离 0~2）；而真的换了一块内容，
 * 至少会有十几个 bit 翻转。
 *
 * ## 成本
 *
 * 72 个格子的平均（每格约 36 个像素）+ 64 次比较，实测 0.04ms/帧。
 * 和 `scorePair` 的 0.5ms 比可以忽略。
 *
 * @param {Float32Array} hsv 64×36 的 HSV 网格
 * @param {Uint8Array} [out] 复用的 8 字节缓冲
 * @returns {Uint8Array} 64 bit（小端位序，比较时只看 popcount，不看具体位置）
 */
export function dHash(hsv, out = new Uint8Array(8)) {
  const GW = 9;
  const GH = 8;
  const grid = new Float32Array(GW * GH);
  for (let gy = 0; gy < GH; gy += 1) {
    const y0 = Math.floor((gy * SCAN_H) / GH);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * SCAN_H) / GH));
    for (let gx = 0; gx < GW; gx += 1) {
      const x0 = Math.floor((gx * SCAN_W) / GW);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * SCAN_W) / GW));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y += 1) {
        const row = y * SCAN_W;
        for (let x = x0; x < x1; x += 1) {
          sum += hsv[(row + x) * 3 + 2];   // 只用 V：色相/饱和度受光照影响大，亮度结构最稳
          n += 1;
        }
      }
      grid[gy * GW + gx] = n ? sum / n : 0;
    }
  }
  out.fill(0);
  let bit = 0;
  for (let gy = 0; gy < GH; gy += 1) {
    for (let gx = 0; gx < GW - 1; gx += 1) {
      if (grid[gy * GW + gx] > grid[gy * GW + gx + 1]) out[bit >> 3] |= (1 << (bit & 7));
      bit += 1;
    }
  }
  return out;
}

/**
 * 两个 dHash 的 Hamming 距离（0–64）。任一为空当"完全不同"（返回 64），
 * 方向选错会把「没法比较」当成「一模一样」——那会静默丢帧。
 */
export function hashDistance(a, b) {
  if (!a || !b) return 64;
  let d = 0;
  for (let i = 0; i < 8; i += 1) {
    let v = a[i] ^ b[i];
    while (v) { d += v & 1; v >>= 1; }
  }
  return d;
}

/** 用候选帧后的画面确认：候选帧改掉的格子，有多少到未来帧还没回到参考背景。 */
export function bgKeep(model, candidate, future, { tau = 15 } = {}) {
  if (!model) return { score: null, changed: 0, kept: 0 };
  const n = SCAN_W * SCAN_H;
  let changed = 0;
  let kept = 0;
  for (let c = 0; c < n; c += 1) {
    const p = c * 3;
    if (hsvDiff(candidate, model.med, p) > tau) {
      changed += 1;
      if (hsvDiff(future, model.med, p) > tau) kept += 1;
    }
  }
  return {
    score: changed === 0 ? null : (kept / changed) * 255,
    changed,
    kept,
  };
}

/**
 * 候选帧改掉了多少外圈（去掉上下黑边）：大面积前景停住时外圈通常还是旧背景；
 * 真正换镜头外圈也会被新画面替换。activeY < 0.25 或全黑时返回 null，保守不判。
 */
export function bgBorderChanged(model, candidate, activeY = 1, { thick = 4, tau = 15 } = {}) {
  if (!model || !(activeY >= 0.25)) return null;
  const bar = activeY >= 0.999 ? 0 : Math.round((1 - activeY) * SCAN_H / 2);
  const t = Math.max(1, Math.min(thick, Math.floor((SCAN_H - bar * 2) / 4)));
  const y0 = bar + t;
  const y1 = SCAN_H - bar - t;
  if (y1 <= y0) return null;
  let total = 0;
  let changed = 0;
  for (let y = bar; y < SCAN_H - bar; y += 1) {
    const edgeRow = y < y0 || y >= y1;
    for (let x = 0; x < SCAN_W; x += 1) {
      if (!(edgeRow || x < t || x >= SCAN_W - t)) continue;
      total += 1;
      if (hsvDiff(candidate, model.med, (y * SCAN_W + x) * 3) > tau) changed += 1;
    }
  }
  if (!total) return null;
  return { score: (changed / total) * 255, changed, total };
}

/** 画面有效高度占比：去掉上下黑边（宽银幕 letterbox），全黑帧返回 0。 */
export function contentHeightRatio(hsv) {
  const darkRow = (y) => {
    let maxV = 0;
    let sum = 0;
    for (let x = 0; x < SCAN_W; x += 1) {
      const v = hsv[(y * SCAN_W + x) * 3 + 2];
      if (v > maxV) maxV = v;
      sum += v;
    }
    return maxV < 24 && sum / SCAN_W < 12;
  };
  let top = 0;
  let bottom = 0;
  while (top < SCAN_H && darkRow(top)) top += 1;
  while (top + bottom < SCAN_H && darkRow(SCAN_H - 1 - bottom)) bottom += 1;
  return (SCAN_H - top - bottom) / SCAN_H;
}

/**
 * 前景守卫用的有效高度：正常情况等同 contentHeightRatio；
 * 全黑帧仍为 0，但“上下暗、中间有亮内容”的暗场不再被当成没有画面。
 */
export function guardHeightRatio(hsv) {
  const ratio = contentHeightRatio(hsv);
  if (ratio >= 0.25) return ratio;
  let maxV = 0;
  const y0 = Math.floor(SCAN_H * 0.25);
  const y1 = Math.ceil(SCAN_H * 0.75);
  for (let y = y0; y < y1; y += 1) {
    for (let x = 0; x < SCAN_W; x += 1) {
      const v = hsv[(y * SCAN_W + x) * 3 + 2];
      if (v > maxV) maxV = v;
    }
  }
  return maxV >= 48 ? 1 : ratio;
}

export function createScorer({
  width, height, scoreMode = 'abs', mcTau = 15, mcRadius = 2, gateMcRadius = mcRadius,
  bgWindow = 6, bgStableRange = 24, bgTau = 15, bgModel = false,
  bgRefWindow = 0, futureMinScore = Infinity,
  /** 单格算「热」的门槛（0–255）。只影响 `hot` 这个读数，不参与切点判定。 */
  hotTau = 24,
}) {
  const n = SCAN_W * SCAN_H;
  const rgb = new Float32Array(n * 3);
  const bgHistory = [];
  const refHistory = [];
  let prev = null;
  let cur = new Float32Array(n * 3);

  return function score(frame) {
    gridRgb(frame, width, height, rgb);
    rgbToHsv(rgb, cur);
    let s = null;
    let peak = 0;
    let hot = 0;
    let hotBox = null;
    let mcScore = null;
    let mcBox = null;
    let mcRect = null;
    let mcFill = null;
    let mcSpanY = 0;
    let bgScore = null;
    let bgStable = 0;
    let bgChanged = 0;
    let bgModelOut = null;
    let futureModel = null;
    const activeY = contentHeightRatio(cur);
    const guardY = guardHeightRatio(cur);
    if (bgWindow > 0 && bgHistory.length >= bgWindow) {
      const bg = bgStats(bgHistory, cur, { stableRange: bgStableRange, tau: bgTau, withModel: bgModel });
      bgScore = bg.score;
      bgStable = bg.stable;
      bgChanged = bg.changed;
      bgModelOut = bg.model;
    }
    if (prev) {
      const mc = mcStats(prev, cur, { tau: mcTau, radius: gateMcRadius });
      mcScore = mc.score;
      mcBox = mc.bbox;
      mcRect = mc.box;
      mcFill = mc.fill;
      mcSpanY = mc.spanY;
      if (scoreMode === 'mc') {
        s = gateMcRadius === mcRadius
          ? mcScore
          : mcRatioScore(prev, cur, { tau: mcTau, radius: mcRadius });
      } else {
        // **同一份循环**里顺手统计 peak/hot：scorePair 与 scorePairDetail 的分数逐位相同，
        // 换成它会多出两个读数但不改任何一个已有行为（见 test/local-score.test.mjs）。
        const d = scorePairDetail(prev, cur, { hotTau });
        s = d.score;
        peak = d.peak;
        hot = d.hot;
        hotBox = d.box;
      }
    }
    if (bgRefWindow > 0
      && s !== null
      && s >= futureMinScore
      && refHistory.length >= Math.min(bgRefWindow, 8)) {
      const ref = bgStats(refHistory, cur, { stableRange: bgStableRange, tau: bgTau, withModel: true });
      futureModel = ref.model;
    }
    const hash = dHash(cur);
    const prevHsv = prev ? Float32Array.from(prev) : null;
    const tmp = prev ?? new Float32Array(n * 3);
    tmp.set(cur);
    prev = tmp;
    if (bgWindow > 0) {
      const snapshot = new Float32Array(n * 3);
      snapshot.set(cur);
      bgHistory.push(snapshot);
      if (bgHistory.length > bgWindow) bgHistory.shift();
    }
    if (bgRefWindow > 0) {
      const snapshot = new Float32Array(n * 3);
      snapshot.set(cur);
      refHistory.push(snapshot);
      if (refHistory.length > bgRefWindow) refHistory.shift();
    }
    return {
      score: s, peak, hot, hotBox, hash, mcScore, mcBox, mcRect, mcFill, mcSpanY, activeY, guardY, bgScore, bgStable, bgChanged,
      bgModel: bgModelOut, futureModel, prevHsv, hsv: cur,
    };
  };
}
