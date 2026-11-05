/**
 * binaries.js — 找 ffmpeg 在哪。
 *
 * 为什么需要：DSH 桌面版把媒体工具装在 `~/.dsh/tools/ffmpeg/bin/`，**不进 PATH**
 * （和 dsh-video-storyboard 用的是同一份）。插件里写裸 `'ffmpeg'`，在 Windows 上
 * 可能刚好能用（OBS 之类会往 PATH 里塞），在 macOS 上就是 ENOENT —— 而这一个
 * ENOENT 会伪装成"插件坏了"。
 *
 * 优先级：
 *  1. 显式环境变量（DSH_FFMPEG_PATH / FFMPEG_PATH / DSH_FFMPEG_DIR）
 *  2. $DSH_HOME/tools/ffmpeg/bin/ffmpeg
 *  3. $DSH_HOME/bin/ffmpeg
 *  4. `where` / `which` 问一次系统（GUI 启动的进程 PATH 常和终端不同）
 *  5. 裸 `ffmpeg`，交给 PATH —— 找不到时由 ffmpeg 自己报 ENOENT，错误信息原样保留
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const exe = (platform) => (platform === 'win32' ? '.exe' : '');

/**
 * 显式问一次系统「这个命令在哪」。
 *
 * 为什么不能只靠裸名交给 PATH：**GUI 方式启动的进程拿到的 PATH 常常和终端不一样**。
 * macOS 从 Dock / Launchpad 启动的 Electron App 由 launchd 拉起，只有
 * `/usr/bin:/bin:/usr/sbin:/sbin`，Homebrew 的 `/opt/homebrew/bin` 根本不在里面；
 * Windows 从快捷方式启动也有同款问题（改过用户级 PATH 但 explorer 没重启）。
 *
 * 表现是同一个：**插件"坏了"，其实只是 ENOENT**。所以再问一次系统，
 * 拿到绝对路径就当命中 —— 真找不到时至少错误信息指向的是真实文件而不是空命令。
 *
 * 同步调用是**故意的**：只在启动时探一次（上层缓存），2.5 秒上限，
 * 换来的是启动日志里能看见「到底用的哪个 ffmpeg」。
 */
function fromPath(name, platform) {
  const bin = platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(bin, [name], {
      encoding: 'utf8', timeout: 2500, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const first = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    return first && existsSync(first) ? first : null;
  } catch {
    // where/which 自己不在、或者没找到 —— 都只是「这条路走不通」，不是错误
    return null;
  }
}

/**
 * @param {{env?:NodeJS.ProcessEnv, platform?:NodeJS.Platform}} [opts]
 * @returns {{path:string, source:string}}
 */
export function resolveFfmpeg({ env = process.env, platform = process.platform } = {}) {
  const name = `ffmpeg${exe(platform)}`;
  const explicit = env.DSH_FFMPEG_PATH || env.FFMPEG_PATH || '';
  if (explicit) return { path: explicit, source: 'env' };

  const dir = env.DSH_FFMPEG_DIR;
  if (dir) return { path: join(dir, name), source: 'DSH_FFMPEG_DIR' };

  const home = env.DSH_HOME || join(env.USERPROFILE || env.HOME || homedir(), '.dsh');
  const candidates = [
    join(home, 'tools', 'ffmpeg', 'bin', name),
    join(home, 'bin', name),
  ];
  for (const path of candidates) {
    if (existsSync(path)) return { path, source: path };
  }
  // 先问系统，再退回裸名 —— 顺序不能反：裸名失败时什么都查不出来
  const found = fromPath('ffmpeg', platform);
  if (found) return { path: found, source: 'where/which' };
  return { path: name, source: 'PATH' };
}
