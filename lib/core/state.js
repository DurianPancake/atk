// state.js —— 链接托管状态读写与安全删除判定（spec F26） by AI.Coding
//
// state.json（用户级/项目级同构）记录 atk 创建的每条链接；
// 安全删除判定：
//   ① 状态中有该链接记录（由调用方按 targetPath 查表保证）
//   ② 当前目标仍是软链
//   ③ readlink 词法解析目标与 state.sourcePath 归一化一致；
//      目标存在时用 realpath 加强复核，目标不存在（断链）不要求 realpath 成功
// （F26：断链可清理，避免上游删技能后 atk 清不掉自己创建的链接）

import { readFile, writeFile, mkdir, rename, lstat, readlink, realpath } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { validateSchema } from './schema.js';

// 启动时一次性加载 state schema（与 config.js 同款式）
const STATE_SCHEMA = JSON.parse(readFileSync(new URL('../../schemas/state.schema.json', import.meta.url), 'utf8'));

/**
 * 空状态结构。
 * @returns {object} { version, links }
 */
export function defaultState() {
  return { version: 1, links: [] };
}

/**
 * 校验状态对象（不符合 schema 抛错，防止坏数据落盘）。
 * @param {*} state 状态数据
 * @returns {string[]} 错误列表（空数组=通过）
 */
export function validateState(state) {
  return validateSchema(state, STATE_SCHEMA);
}

/**
 * 读取状态文件；不存在返回空状态。
 * @param {string} file 状态文件路径
 * @returns {Promise<object>} 状态对象
 * @throws 文件存在但非法时抛出
 */
export async function loadState(file) {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return defaultState();
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`state.json 解析失败（${file}）：${err.message}`);
  }
  const errors = validateState(data);
  if (errors.length > 0) {
    throw new Error(`state.json 校验失败（${file}）：\n${errors.join('\n')}`);
  }
  return data;
}

/**
 * 原子写入状态（临时文件 + rename；F17 单文件写入原子替换约定）。
 * @param {string} file 状态文件路径
 * @param {object} state 状态数据（包含本次全部已完成操作）
 * @returns {Promise<string>} 写入路径
 */
export async function saveState(file, state) {
  const errors = validateState(state);
  if (errors.length > 0) throw new Error(`state.json 校验失败，拒绝写入：\n${errors.join('\n')}`);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return file;
}

/**
 * 按 targetPath 查找状态条目。
 * @param {object} state 状态对象
 * @param {string} targetPath 链接目标路径
 * @returns {object|undefined} 命中的条目
 */
export function findEntry(state, targetPath) {
  const norm = path.resolve(targetPath);
  return state.links.find((l) => path.resolve(l.targetPath) === norm);
}

/**
 * 删除满足条件的条目（collection/client 级清理用）。
 * @param {object} state 状态对象（就地修改）
 * @param {(entry: object) => boolean} predicate 返回 true 的条目被删除
 * @returns {object[]} 被删除的条目列表
 */
export function removeEntries(state, predicate) {
  const kept = [];
  const removed = [];
  for (const entry of state.links) {
    if (predicate(entry)) removed.push(entry);
    else kept.push(entry);
  }
  state.links = kept;
  return removed;
}

/**
 * 安全删除判定（F26，断链可清）。
 * @param {object} entry 状态条目（含 sourcePath）
 * @param {string} linkPath 目标链接路径
 * @returns {Promise<{safe: boolean, reason: string}>} 是否安全删除及原因
 */
export async function isSafeToRemove(entry, linkPath) {
  // ② 当前目标仍是软链
  let st;
  try {
    st = await lstat(linkPath);
  } catch {
    return { safe: false, reason: '目标不存在（无需删除）' };
  }
  if (!st.isSymbolicLink()) {
    return { safe: false, reason: '目标不是软链（可能是用户内容），拒绝删除' };
  }
  // ③ 词法判定：readlink 目标解析后与状态记录一致（主要依据）
  let raw;
  try {
    raw = await readlink(linkPath);
  } catch {
    return { safe: false, reason: '读取软链目标失败' };
  }
  const lexical = path.resolve(path.dirname(linkPath), raw);
  const expected = path.resolve(entry.sourcePath);
  if (lexical !== expected) {
    return { safe: false, reason: `软链指向 ${lexical}，与状态记录 ${expected} 不一致` };
  }
  // ③+ 目标存在时 realpath 强复核；目标不存在（断链）不要求 realpath 成功
  try {
    const real = await realpath(linkPath);
    const realExpected = await realpath(expected).catch(() => null);
    if (realExpected !== null && real !== realExpected) {
      return { safe: false, reason: `realpath 复核不一致：${real} ≠ ${realExpected}` };
    }
  } catch {
    // realpath 失败 = 断链：词法判定已通过，允许清理
  }
  return { safe: true, reason: 'ok' };
}