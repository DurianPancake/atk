// cli/index.js —— atk 命令分发入口 by AI.Coding
//
// 已接入：status（T4）/apply（T5）/collection（T7）/defaults/validate（T8）。
// 剩余：sync（T9）与 setup.js --install-atk 集成（T10）。
// M2 起：copy-skill/rename-skill/init/edit 与 --project 参数已移除（R1/R2/R5/R7）。

import { VERSION } from '../index.js';
import { collectStatus } from '../core/status.js';
import { planInstall } from '../core/plan.js';
import { runApply } from '../core/apply.js';
import {
  registerCollection, removeCollection, setCollectionEnabled, listCollections, exportSkill,
} from '../core/collections.js';
import { setSkillDefault } from '../core/defaults.js';
import { validateCollection } from '../core/validate.js';
import { syncCollections } from '../core/sync.js';
import { renderStatus, renderPlan, renderApplyResult, renderCollectionList } from './render.js';
import { parseArgs } from './args.js';

/**
 * 打印帮助文本。
 * @param {NodeJS.WritableStream} out 输出流（便于测试注入）
 */
function printHelp(out) {
  out.write(`atk - 技能集合懒加载管理工具 v${VERSION}

用法：
  atk <命令> [选项]

命令：
  status [--json]                       查看状态（纯只读，仅用户级）
  apply  [--dry-run]                    应用技能集合到 5 个客户端用户级目录（两阶段，可恢复）
  collection add|remove|enable|disable|list|export  集合管理
  defaults disable|enable <技能>        维护基础层默认停用列表
  validate collection <目录>            校验集合（按级别输出，退出码表示是否干净）
  sync    [--no-apply]                  更新 git 集合并重新应用
  -v, --version                         输出版本信息
  -h, --help                            显示本帮助
`);
}

/**
 * CLI 入口：解析 argv 并分发。
 * @param {string[]} argv 命令行参数（不含 node 与脚本路径）
 * @param {object} io 注入的 IO 对象（便于测试），默认取 process
 * @returns {Promise<number>} 进程退出码
 */
export async function run(argv, io = process) {
  const [cmd, ...rest] = argv;
  if (cmd === '--version' || cmd === '-v') {
    io.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (cmd === '--help' || cmd === '-h' || cmd === undefined) {
    printHelp(io.stdout);
    return 0;
  }

  try {
    switch (cmd) {
      case 'status': {
        const { flags } = parseArgs(rest, [], ['--json']);
        const data = await collectStatus({ cwd: process.cwd(), home: process.env.HOME });
        io.stdout.write(renderStatus(data, { json: flags.has('json') }));
        io.stdout.write('\n');
        return 0;
      }
      case 'apply': {
        // 两阶段：dry-run 只规划（零写入）；真实执行按结果退出码返回（部分失败=非 0，可再次收敛）
        const { flags } = parseArgs(rest, [], ['--dry-run']);
        const plan = await planInstall({ cwd: process.cwd(), home: process.env.HOME });
        if (flags.has('dry-run')) {
          io.stdout.write(renderPlan(plan));
          io.stdout.write('\n');
          return plan.errors.length > 0 ? 1 : 0;
        }
        const res = await runApply(plan);
        io.stdout.write(renderApplyResult(res));
        io.stdout.write('\n');
        return res.exitCode;
      }
      case 'collection': {
        const [sub, ...subArgs] = rest;
        const home = process.env.HOME;
        if (sub === 'add') {
          // atk collection add <git-url|路径> [--scope] [--tag] [--name] [--priority] [--branch]
          const { options, positional } = parseArgs(subArgs, ['--scope', '--tag', '--name', '--priority', '--branch']);
          const source = positional[0];
          if (!source) throw new Error('用法：atk collection add <git-url|本地路径>');
          const res = await registerCollection({
            home, source, name: options.name, scope: options.scope, tag: options.tag,
            priority: options.priority !== undefined ? Number(options.priority) : undefined,
            branch: options.branch,
          });
          if (!res.ok) throw new Error(res.error);
          io.stdout.write(`集合 "${res.name}" 已注册${res.collection?.scope === 'global' ? '（global，注册即装）' : '（scoped，需 enable 后 apply 才装）'}\n`);
          return 0;
        }
        if (sub === 'remove') {
          const { positional } = parseArgs(subArgs);
          const name = positional[0];
          if (!name) throw new Error('用法：atk collection remove <集合名>');
          const res = await removeCollection({ home, name });
          if (!res.ok) throw new Error(res.error);
          io.stdout.write(`集合 "${name}" 已移除，清理链接 ${res.cleaned} 条\n`);
          for (const w of res.warnings) io.stderr.write(`  ! ${w}\n`);
          return 0;
        }
        if (sub === 'enable' || sub === 'disable') {
          // F03：--dry-run 只预览将变更的启用状态（零写入）
          const { flags, positional } = parseArgs(subArgs, [], ['--dry-run']); // enable/disable（W3）
          const name = positional[0];
          if (!name) throw new Error('用法：atk collection enable|disable <集合名> [--dry-run]');
          const target = sub === 'enable';
          if (flags.has('dry-run')) {
            const rows = await listCollections(home);
            const cur = rows.find((r) => r.name === name);
            if (!cur) throw new Error(`集合 "${name}" 未注册`);
            io.stdout.write(
              `集合 "${name}" 当前${cur.enabled ? '启用' : '停用'} → 将${target ? '启用' : '停用'}` +
              `（dry-run，未写入；${target ? '启用后' : '停用后'}下次 apply 生效）\n`
            );
            return 0;
          }
          const res = await setCollectionEnabled({ home, name, enabled: target });
          if (!res.ok) throw new Error(res.error);
          io.stdout.write(`集合 "${name}" 已${target ? '启用' : '停用'}（下次 apply 生效）\n`);
          return 0;
        }
        if (sub === 'list') {
          const rows = await listCollections(home);
          io.stdout.write(renderCollectionList(rows));
          io.stdout.write('\n');
          return 0;
        }
        if (sub === 'export') {
          const { options, positional } = parseArgs(subArgs, ['--to']);
          const [collectionName, skill] = positional;
          if (!collectionName || !skill || !options.to) throw new Error('用法：atk collection export <集合> <技能> --to <目标目录>');
          const res = await exportSkill({ home, collection: collectionName, skill, dest: options.to });
          if (!res.ok) throw new Error(res.error);
          io.stdout.write(`已导出 ${res.files.length} 个文件到 ${options.to}/skills/${skill}\n`);
          return 0;
        }
        io.stderr.write(`atk: 未知 collection 子命令 "${sub}"（add/remove/enable/disable/list/export）\n`);
        return 1;
      }
      case 'defaults': {
        const [sub, skillName] = rest;
        if (sub === 'disable' || sub === 'enable') {
          if (!skillName) throw new Error('用法：atk defaults disable|enable <技能>');
          const res = await setSkillDefault({ home: process.env.HOME, skill: skillName, enabled: sub === 'enable' });
          if (!res.ok) throw new Error(res.error);
          io.stdout.write(`基础默认 ${sub === 'disable' ? '停用' : '启用'} "${skillName}"（当前 disabled: [${res.disabled.join(', ')}]）\n`);
          return 0;
        }
        io.stderr.write('atk: 用法：atk defaults disable|enable <技能>\n');
        return 1;
      }
      case 'validate': {
        const [sub, target] = rest;
        if (sub !== 'collection' || !target) throw new Error('用法：atk validate collection <目录>');
        const res = await validateCollection(target);
        for (const e of res.errors) io.stdout.write(`  ✗ [error] ${e}\n`);
        for (const w of res.warnings) io.stdout.write(`  ! [warning] ${w}\n`);
        for (const n of res.notes) io.stdout.write(`  · [note] ${n}\n`);
        io.stdout.write(`校验完成：${res.errors.length} error / ${res.warnings.length} warning / ${res.notes.length} note\n`);
        return res.ok ? 0 : 1;
      }
      case 'sync': {
        const { flags } = parseArgs(rest, [], ['--no-apply']);
        const res = await syncCollections({
          cwd: process.cwd(), home: process.env.HOME,
          noApply: flags.has('no-apply'),
        });
        for (const c of res.collections) {
          const mark = c.status === 'failed' ? '✗' : c.status.startsWith('skipped') ? '!' : '+';
          io.stdout.write(`  ${mark} ${c.name}: ${c.status}${c.message ? `（${c.message}）` : ''}\n`);
        }
        if (res.apply) {
          io.stdout.write(`应用：${res.apply.applied.length} 链接、${res.apply.skipped.length} 跳过、${res.apply.failed.length} 失败\n`);
        }
        return res.exitCode;
      }
      default:
        io.stderr.write(`atk: 未知命令 "${cmd}"\n`);
        return 1;
    }
  } catch (err) {
    // 坏配置/非法参数：打印错误并返回非 0（F17：声明非法不碰产物）
    io.stderr.write(`atk: ${err.message}\n`);
    return 1;
  }
}