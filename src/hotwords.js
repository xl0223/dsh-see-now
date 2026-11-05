/**
 * hotwords.js — 让转写认得游戏/引擎的术语。
 *
 * ## 两条路，一条治本一条治标
 *
 * **热词**（`hotword`）：交给转写服务当解码提示，让模型**本来就往这些词上靠**。
 * FunASR / paraformer 的 OpenAI 兼容服务认这个字段（逗号分隔）。治本，但只有
 * http 后端能用 —— 宿主自带的 SenseVoice 没有对应接口。
 *
 * **错词表**（`fixes`）：转写回来之后做一次精确替换。治标，但对**任何后端都生效**，
 * 包括宿主。中文 ASR 对术语的错法高度集中（同音字），一个两字映射就能修掉一大片：
 * "才质" / "蓝兔" / "实力化" / "关键针"。
 *
 * 两条一起用才够：热词减少出错，错词表兜住剩下的。
 *
 * ## 为什么不直接改 `asr.json`
 *
 * 那份是**和 `dsh-video-storyboard` 共用**的（谁先配置谁用）。往里面塞 see-now
 * 专用的热词，会把 storyboard 的转写也带偏 —— 它看的可能是别的内容。
 * 所以 see-now 自己的词表放在 `~/.dsh/see-now.json` 的 `asr` 段。
 */

/**
 * 默认热词。**只放「说出来时容易听岔、但在这类内容里高频」的词**，
 * 不放通用词 —— 热词给多了会反过来压低识别率（解码器被迫在更多候选里选）。
 */
export const DEFAULT_HOTWORDS = Object.freeze([
  '材质', '贴图', '着色器', '渲染管线', '光照', '法线', '烘焙',
  '网格体', '骨骼', '蒙皮', '权重', '关键帧', '动画蓝图', '状态机',
  '碰撞体', '刚体', '关节', '物理材质', '触发器',
  '蓝图', '预制体', '实例化', '组件', '关卡', '视口', '大纲',
  '位移', '旋转', '缩放', '变换', '坐标系', '局部空间', '世界空间',
  '后处理', '景深', '动态模糊', '泛光', '色调映射',
  'LOD', 'Nanite', 'Lumen', 'Niagara', 'World Partition',
  'Godot', 'Unreal', 'Unity', 'Blender',
]);

/**
 * 错词 → 正词。**只收「本身就是错字、不可能出现在正常语句里」的写法**。
 *
 * 判断标准很硬：如果把这个字符串单独拿出来，它是不是只可能是误识别？
 * "骨架"是对的（不能改成"骨骼"）、"网格"是对的（不改成别的）、
 * "材质球"是对的（不拆）。拿不准的一律不收 —— 错词表的代价是**把对的改错**，
 * 那比不修更糟：模型会照着错的内容推理。
 */
export const DEFAULT_FIXES = Object.freeze({
  才质: '材质',
  材制: '材质',
  蓝兔: '蓝图',
  兰图: '蓝图',
  实力化: '实例化',
  实力话: '实例化',
  光找: '光照',
  光罩: '光照',
  网各: '网格',
  网阁: '网格',
  骨革: '骨骼',
  关键针: '关键帧',
  碰壮: '碰撞',
  碰装: '碰撞',
  位一: '位移',
  位仪: '位移',
  烘赔: '烘焙',
  烘培: '烘焙',
  贴土: '贴图',
  帖图: '贴图',
  着色气: '着色器',
  着色齐: '着色器',
  渲染管到: '渲染管线',
  渲染管线图: '渲染管线',
  预制体: '预制体',
  虚换: '虚幻',
  戈多: 'Godot',
  有尼提: 'Unity',
  尤尼提: 'Unity',
  布兰德尔: 'Blender',
  伯兰德: 'Blender',
  安瑞尔: 'Unreal',
  妮亚加拉: 'Niagara',
  罗门: 'Lumen',
  纳奈特: 'Nanite',
});

/** 一份配置最多带多少热词 —— 再多会稀释解码概率，反而更差。 */
export const MAX_HOTWORDS = 40;

/**
 * 按错词表做一次精确替换。
 *
 * **长词优先**：`渲染管到` 要在 `渲染` 之类的短词之前命中，否则长错词会被
 * 短词的替换切碎，剩下半截再也匹配不上。
 *
 * @param {string} text 转写回来的一句话
 * @param {Record<string,string>} [fixes] 默认用内置表；传 `{}` 等于关掉
 * @returns {string}
 */
export function applyFixes(text, fixes = DEFAULT_FIXES) {
  const s = String(text ?? '');
  if (!s || !fixes) return s;
  const keys = Object.keys(fixes).filter((k) => k && k !== fixes[k]).sort((a, b) => b.length - a.length);
  let out = s;
  for (const k of keys) {
    if (out.includes(k)) out = out.split(k).join(fixes[k]);
  }
  return out;
}

/**
 * 热词表 → 转写服务要的那个字段。
 *
 * FunASR 的 OpenAI 兼容层收的是**逗号分隔的一个字符串**（`hotword`），
 * 不是数组；发数组过去多数实现会直接忽略（静默失效，最难查）。
 *
 * @param {string[]|string} terms
 * @returns {string} 没有可用词时返回空串（调用方据此不塞字段）
 */
export function hotwordString(terms, max = MAX_HOTWORDS) {
  const list = Array.isArray(terms) ? terms : String(terms ?? '').split(/[,，\s]+/);
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const t = String(raw ?? '').trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= max) break;
  }
  return out.join(',');
}

/**
 * 从 `see-now.json` 的 `asr` 段解出实际要用的两项。
 *
 * `hotwords: []` 是**明确关掉**（不是"用默认"）；不写这个键才用默认表。
 * 这个区分很重要：用户说"别给我加词"时，空数组是他唯一的表达方式。
 *
 * @param {{hotwords?:string[]|null, fixes?:Record<string,string>|null, autoFix?:boolean}} [asr]
 */
export function resolveAsrTerms(asr) {
  const cfg = asr && typeof asr === 'object' ? asr : {};
  const hotwords = Array.isArray(cfg.hotwords)
    ? cfg.hotwords
    : (cfg.hotwords === false ? [] : DEFAULT_HOTWORDS);
  const fixes = cfg.fixes && typeof cfg.fixes === 'object' && !Array.isArray(cfg.fixes)
    ? { ...DEFAULT_FIXES, ...cfg.fixes }
    : (cfg.fixes === false ? {} : DEFAULT_FIXES);
  return { hotwords, fixes };
}
