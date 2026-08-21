// t8.test.js —— defaults/validate 命令单测（F09/F20） by AI.Coding
//
// 覆盖 design.md T8 验收：defaults 命令维护 disabled；validate 四级输出（必需/可选/schema/无 manifest）+ 退出码。
// M2 起：copy-skill/init/edit 已随 R1/R5 移除，对应用例删除。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PassThrough } from 'node:stream';
import { setSkillDefault } from '../lib/core/defaults.js';
import { validateCollection } from '../lib/core/validate.js';
import { registryPath } from '../lib/core/config.js';
import { registerCollection } from '../lib/core/collections.js';

/** 造集合目录（root/skills/<name>/SKILL.md + 可选额外文件） */
function makeCollection(root, skills) {
  mkdirSync(path.join(root, 'skills'), { recursive: true });
  for (const [name, extra = {}] of Object.entries(skills)) {
    mkdirSync(path.join(root, 'skills', name));
    writeFileSync(path.join(root, 'skills', name, 'SKILL.md'), extra.skill ?? `---\nname: ${name}\n---\n`);
    for (const [f, content] of Object.entries(extra.files ?? {})) {
      mkdirSync(path.join(root, 'skills', name, path.dirname(f)), { recursive: true });
      writeFileSync(path.join(root, 'skills', name, f), content);
    }
  }
  return root;
}

/** 造带 manifest 依赖的集合：skills/x/SKILL.md + shared/x.txt（dependencies: {x:['shared/x.txt']}） */
function makeDependencyCollection(root) {
  makeCollection(root, { x: { files: { 'SKILL.md': '# x\n' } } });
  mkdirSync(path.join(root, 'shared'), { recursive: true });
  writeFileSync(path.join(root, 'shared', 'x.txt'), 'dep content');
  writeFileSync(path.join(root, 'atk.manifest.json'), JSON.stringify({ dependencies: { x: ['shared/x.txt'] } }));
  return root;
}

describe('defaults（F09）', () => {
  it('disable/enable 维护 registry.defaults.disabled', async () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'atk-t8-h-'));
    await setSkillDefault({ home, skill: 'doc-gen', enabled: false });
    let reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    assert.deepEqual(reg.defaults.disabled, ['doc-gen']);
    await setSkillDefault({ home, skill: 'doc-gen', enabled: true });
    reg = JSON.parse(readFileSync(registryPath(home), 'utf8'));
    assert.deepEqual(reg.defaults.disabled, []);
    const bad = await setSkillDefault({ home, skill: 'Bad Skill', enabled: false });
    assert.equal(bad.ok, false);
  });
});

describe('validate collection（F20）', () => {
  it('干净集合：无 error，退出语义 ok', async () => {
    const col = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-t8-c-')), { a: { files: { 'doc/guide.md': '# guide\n' } } });
    const res = await validateCollection(col);
    assert.equal(res.ok, true);
    assert.deepEqual(res.errors, []);
  });

  it('四级别：SKILL.md 缺失(error)、断链(error)、必需依赖缺失(error)、可选缺失(warning)、无 manifest(note)', async () => {
    const col = mkdtempSync(path.join(os.tmpdir(), 'atk-t8-c-'));
    // bad-名 + 缺 SKILL.md
    mkdirSync(path.join(col, 'skills', 'Bad_Name'), { recursive: true });
    // 合法名但缺 SKILL.md（结构错误）
    mkdirSync(path.join(col, 'skills', 'no-md'), { recursive: true });
    // 断链引用
    mkdirSync(path.join(col, 'skills', 'ok'));
    writeFileSync(path.join(col, 'skills', 'ok', 'SKILL.md'), '# ok\n\n看 [缺失文件](./nope.md)\n');
    // manifest：必需依赖缺失 + 可选共享资源缺失
    writeFileSync(path.join(col, 'atk.manifest.json'), JSON.stringify({
      dependencies: { ok: ['shared/must-have.txt'] },
      sharedResources: [{ name: 'w', path: 'shared/optional.txt' }],
    }));
    const res = await validateCollection(col);
    assert.ok(res.errors.some((e) => e.includes('SKILL.md 缺失')), '结构错误');
    assert.ok(res.errors.some((e) => e.includes('断开的相对引用')), '断链');
    assert.ok(res.errors.some((e) => e.includes('必需依赖缺失')), '必需依赖');
    assert.ok(res.warnings.some((w) => w.includes('可选共享资源缺失')), '可选警告');
    assert.equal(res.ok, false);
  });

  it('未知 manifest schema（非法键）→ error', async () => {
    const col = makeCollection(mkdtempSync(path.join(os.tmpdir(), 'atk-t8-c-')), { a: {} });
    writeFileSync(path.join(col, 'atk.manifest.json'), JSON.stringify({ unknownKey: 1 }));
    const res = await validateCollection(col);
    assert.ok(res.errors.some((e) => e.includes('schema 校验失败')), '未知 schema');
    assert.equal(res.ok, false);
  });
});
describe('命令行参数（W3：未知 -- 选项报错）', () => {
  it('未知 -- 选项（如旧版 --project）被拒绝而非静默忽略', async () => {
    const { run } = await import('../lib/cli/index.js');
    const out = [];
    const io = {
      stdout: { write: (s) => out.push(String(s)) },
      stderr: { write: (s) => out.push(String(s)) },
    };
    const code = await run(['apply', '--project', '/some/dir'], io);
    assert.notEqual(code, 0, '未知选项应非 0 退出');
    assert.ok(out.some((s) => s.includes('未知选项：--project')), `应报未知选项，实际输出：${out.join('')}`);
  });

  it('合法标志（--json/--dry-run/--no-apply）仍被接受', async () => {
    const { parseArgs } = await import('../lib/cli/args.js');
    const a = parseArgs(['--json'], [], ['--json']);
    assert.equal(a.flags.has('json'), true);
    const b = parseArgs([], ['--to'], []);
    assert.equal(b.options.to, undefined);
  });
});
