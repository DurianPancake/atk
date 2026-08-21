// sync.js —— atk sync：更新全部 git 集合并重新应用（spec F19/F25） by AI.Coding
//
// 语义（F19）：
//   ① 逐个 git 集合：fetch + `--ff-only`；dirty/detached 警告跳过；clone 目录丢失重建
//   ② 拉取失败的集合继续使用本地旧版本（不中断其余集合）
//   ③ 重新扫描全部可用集合
//   ④ 应用全部已启用集合（M3 起仅用户级）
//   ⑥ 任一拉取失败最终退出非 0，但不阻止 apply；`--no-apply` 可选（P2）
// 防递归（F25）：所有 git 命令以 ATK_NO_HOOK=1 环境执行，post-merge hook 检测该变量即退出，
//   避免 sync 内 fetch/merge 再次触发 hook 造成无限递归。

import { stat, mkdir, readFile, unlink, open } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadRegistry } from './config.js';
import { collectionRoot } from './collection.js';
import { planInstall } from './plan.js';
import { runApply } from './apply.js';

const execFileP = promisify(execFile);

// F19 ①：非交互 + 超时——网络命令不得挂起等待凭据输入；超时（60s）强制终止
const GIT_TIMEOUT_MS = 60_000;
const GIT_ENV = { ...process.env, ATK_NO_HOOK: '1', GIT_TERMINAL_PROMPT: '0' };

/** git 命令统一执行器（注入防递归 + 非交互环境，超时保护）。 */
async function git(dir, args) {
  const { stdout, stderr } = await execFileP('git', args, {
    cwd: dir,
    env: GIT_ENV, // F25 防递归 + F19 非交互（GIT_TERMINAL_PROMPT=0）
    timeout: GIT_TIMEOUT_MS,
  });
  return { stdout: stdout.trim(), stderr: stderr.trim() };
}

// ── 进程锁（F19 ①）：并发 sync 互斥，stale/进程死亡可抢占 ──
const LOCK_STALE_MS = 10 * 60 * 1000; // 锁超过 10 分钟视为 stale（崩溃残留可回收）

/**
 * 获取 sync 锁（原子创建 + stale/进程死亡抢占）。
 * @param {string} home 主目录
 * @returns {Promise<{held: boolean, file: string}>} 是否持锁及锁文件路径
 */
async function acquireSyncLock(home) {
  const file = path.join(home, '.config', 'atk', 'sync.lock');
  await mkdir(path.dirname(file), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fh = await open(file, 'wx');
      await fh.writeFile(JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      await fh.close();
      return { held: true, file };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      // 已有锁：pid 存活（kill 信号 0 成功）→ 持锁进程仍在，绝不抢占（防并发 sync）；
      // pid 缺失/进程已死 → stale 可抢占；pid 不可解析时才以年龄阈值兜底（崩溃残留）
      let stale = false;
      try {
        const info = JSON.parse(await readFile(file, 'utf8'));
        if (info.pid) {
          try { process.kill(info.pid, 0); } catch { stale = true; } // 进程已死 → 可抢占
        } else {
          stale = Date.now() - (info.startedAt || 0) > LOCK_STALE_MS; // 无 pid 的旧格式锁：年龄兜底
        }
      } catch { stale = true; } // 锁文件损坏 → 视为 stale
      if (stale) {
        // 抢占 stale 锁：双进程同时抢占时另一方先删 → ENOENT 视为已抢占，重试写自己的锁
        try {
          await unlink(file);
        } catch {
          /* 已被他方删除，直接重试 */
        }
        continue;
      }
      return { held: false, file };
    }
  }
  return { held: false, file };
}

/** 释放 sync 锁（仅删自己持有写入的锁文件，避免误删新持有者）。 */
async function releaseSyncLock(file) {
  try {
    const info = JSON.parse(await readFile(file, 'utf8'));
    if (info.pid === process.pid) await unlink(file);
  } catch { /* 锁文件已不存在或损坏：无需处理 */ }
}

/** 目录是否存在。 */
async function exists(dir) {
  try {
    await stat(dir);
    return true;
  } catch {
    return false;
  }
}

/**
 * 同步单个 git 集合。
 * @param {object} collection 注册表条目（type=git）
 * @param {string} home 主目录
 * @returns {Promise<{name: string, status: string, message?: string}>} 结果
 */
async function syncOne(collection, home) {
  const dir = collectionRoot(collection, home);
  try {
    // clone 目录丢失 → 重建（F19 ①）
    if (!(await exists(dir))) {
      const args = ['clone', '--quiet'];
      if (collection.branch) args.push('-b', collection.branch);
      args.push(collection.url, dir);
      await execFileP('git', args, { env: GIT_ENV, timeout: GIT_TIMEOUT_MS }); // F25 防递归 + F19 非交互/超时
      return { name: collection.name, status: 'recloned', message: 'clone 丢失，已重建' };
    }
    // detached HEAD → 跳过（无法 ff-only 合并）
    try {
      await git(dir, ['symbolic-ref', '-q', 'HEAD']);
    } catch {
      return { name: collection.name, status: 'skipped-detached', message: 'HEAD 处于 detached 状态，跳过更新' };
    }
    // dirty → 跳过（避免破坏本地修改；F19 警告跳过）
    const { stdout: porcelain } = await git(dir, ['status', '--porcelain']);
    if (porcelain.length > 0) {
      return { name: collection.name, status: 'skipped-dirty', message: '工作区有未提交修改，跳过更新' };
    }
    // 上游分支：注册 branch 优先，否则取当前跟踪分支
    let branch = collection.branch;
    if (!branch) {
      try {
        const { stdout: upstream } = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
        branch = upstream.split('/').slice(1).join('/'); // origin/<branch> → <branch>
      } catch {
        return { name: collection.name, status: 'failed', message: '无跟踪分支（@{u}）' };
      }
    }
    // fetch + ff-only（git() 已注入 GIT_TERMINAL_PROMPT=0 与超时，F19 ①）
    await git(dir, ['fetch', 'origin']);
    await git(dir, ['merge', '--ff-only', `origin/${branch}`]);
    return { name: collection.name, status: 'synced', message: `已更新到 origin/${branch}` };
  } catch (err) {
    // F19 ②：拉取失败 → 本地旧版本继续使用（返回失败状态，不抛）
    return { name: collection.name, status: 'failed', message: err.message };
  }
}

/**
 * 执行一次 sync（更新 + 重新应用）。
 * @param {object} opts 参数
 * @param {string} opts.cwd 当前工作目录
 * @param {string} [opts.home] 主目录
 * @param {boolean} [opts.noApply] 跳过同步后 apply（P2）
 * @returns {Promise<{collections: Array<object>, apply: object|null, exitCode: number}>} 结果
 */
export async function syncCollections({ cwd, home, noApply = false }) {
  // F19 ①：进程锁互斥（另一 sync 运行中 → 跳过本轮，不并发拉取同一 clone）
  const lock = await acquireSyncLock(home);
  if (!lock.held) {
    return {
      collections: [{ name: 'sync', status: 'locked', message: '另一 sync 进行中，本轮跳过（防止并发拉取）' }],
      apply: null,
      exitCode: 1,
    };
  }
  try {
    const registry = await loadRegistry(home);
    const gitCollections = registry.collections.filter((c) => c.type === 'git');
    const collections = [];
    let anyFailed = false;
    for (const collection of gitCollections) {
      const res = await syncOne(collection, home);
      collections.push(res);
      if (res.status === 'failed') anyFailed = true;
    }
    // F19 ③④⑤：重新扫描 + 应用（global + 当前项目）
    let apply = null;
    if (!noApply) {
      const plan = await planInstall({ cwd, home });
      const result = await runApply(plan);
      apply = { ...result, planErrors: plan.errors };
      if (plan.errors.length > 0) anyFailed = true;
    }
    // F19 ⑥：任一拉取失败 → 非 0；apply 部分失败同样非 0
    const exitCode = anyFailed || (apply && apply.exitCode !== 0) ? 1 : 0;
    return { collections, apply, exitCode };
  } finally {
    await releaseSyncLock(lock.file);
  }
}