// state.test.js —— 托管状态与安全删除判定单测 by AI.Coding
//
// 覆盖 design.md T5 验收的一环：F26 断链可清理（词法判定）、realpath 复核、非软链拒绝、原子落盘。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { defaultState, loadState, saveState, validateState, findEntry, removeEntries, isSafeToRemove } from '../lib/core/state.js';

/** 造临时工作目录 */
function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'atk-state-'));
}

describe('state: 读写与校验', () => {
  it('无文件返回空状态；保存后可读回且无 tmp 残留', async () => {
    const dir = tempDir();
    const file = path.join(dir, 'state.json');
    assert.deepEqual(await loadState(file), defaultState());
    const state = defaultState();
    state.links.push({ kind: 'skill', client: 'dsh', targetPath: '/t/x', sourcePath: '/s/x', collection: 'c', ownerSkill: null, profileHash: 'abc' });
    await saveState(file, state);
    assert.deepEqual(await loadState(file), state);
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.tmp')), []);
  });

  it('校验失败拒绝写入', async () => {
    const file = path.join(tempDir(), 'state.json');
    await assert.rejects(() => saveState(file, { version: 1, links: [{ bad: true }] }), /校验失败/);
    assert.equal(existsSync(file), false);
  });

  it('findEntry / removeEntries 按 targetPath 工作', () => {
    const state = defaultState();
    const a = { kind: 'skill', client: 'dsh', targetPath: '/t/a', sourcePath: '/s/a', collection: 'c', ownerSkill: null, profileHash: 'h' };
    const b = { ...a, targetPath: '/t/b' };
    state.links.push(a, b);
    assert.equal(findEntry(state, '/t/a'), a);
    assert.equal(findEntry(state, '/t/nope'), undefined);
    const removed = removeEntries(state, (e) => e.targetPath === '/t/a');
    assert.equal(removed.length, 1);
    assert.equal(state.links.length, 1);
  });
});

describe('isSafeToRemove（F26 断链可清）', () => {
  const entry = (targetPath, sourcePath) => ({ kind: 'skill', client: 'dsh', targetPath, sourcePath, collection: 'c', ownerSkill: null, profileHash: 'h' });

  it('断链（source 已删除）：词法一致 → 安全可清理', async () => {
    const dir = tempDir();
    const src = path.join(dir, 'src');
    const tgt = path.join(dir, 'link');
    mkdirSync(src);
    symlinkSync(src, tgt);
    rmSync(src, { recursive: true }); // 制造断链
    const { safe } = await isSafeToRemove(entry(tgt, src), tgt);
    assert.equal(safe, true);
  });

  it('目标被改指向（词法不一致）→ 不安全', async () => {
    const dir = tempDir();
    const src = path.join(dir, 'src');
    const other = path.join(dir, 'other');
    const tgt = path.join(dir, 'link');
    mkdirSync(src);
    mkdirSync(other);
    symlinkSync(other, tgt); // 用户改指向 other
    const { safe } = await isSafeToRemove(entry(tgt, src), tgt);
    assert.equal(safe, false);
  });

  it('目标非软链（真实目录）→ 不安全', async () => {
    const dir = tempDir();
    const src = path.join(dir, 'src');
    const tgt = path.join(dir, 'link');
    mkdirSync(src);
    mkdirSync(tgt); // 真实目录
    const { safe } = await isSafeToRemove(entry(tgt, src), tgt);
    assert.equal(safe, false);
  });

  it('目标不存在 → 不安全（无需删除）', async () => {
    const dir = tempDir();
    const { safe } = await isSafeToRemove(entry(path.join(dir, 'x'), path.join(dir, 's')), path.join(dir, 'x'));
    assert.equal(safe, false);
  });

  it('目标存在且 realpath 复核一致 → 安全', async () => {
    const dir = tempDir();
    const src = path.join(dir, 'src');
    const tgt = path.join(dir, 'link');
    mkdirSync(src);
    symlinkSync(src, tgt);
    const { safe } = await isSafeToRemove(entry(tgt, src), tgt);
    assert.equal(safe, true);
  });

  it('validateState 拒绝非法 client 枚举', () => {
    const s = defaultState();
    s.links.push({ kind: 'skill', client: 'not-a-client', targetPath: '/t', sourcePath: '/s', collection: 'c', ownerSkill: null, profileHash: 'h' });
    assert.match(validateState(s).join('\n'), /client/);
  });
});