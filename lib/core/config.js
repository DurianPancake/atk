// config.js —— atk 用户级注册表与项目声明读写 by AI.Coding
//
// 职责（spec F01/F05/F17/F21）：
// - ~/.config/atk/collections.json：读、原子写（临时文件 + rename）、schema 校验
// - 用户级注册表 <~/.config/atk>/collections.json：读取 + schema 校验（写入由 collection/defaults 命令负责）
// 所有单文件写入均为原子替换（F17：注册表写入用临时文件+rename）。

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { validateSchema } from './schema.js';

// 通过 import.meta.url 定位 schema 文件，与进程 cwd 无关（打包/发布后依然可用）
const SCHEMAS = {
  registry: readSchema('collections.schema.json'),
};

/**
 * 读取并解析一个本地 schema 文件（启动时一次性加载）。
 * @param {string} name schema 文件名
 * @returns {object} 解析后的 schema 对象
 */
function readSchema(name) {
  const url = new URL(`../../schemas/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8'));
}

/**
 * 用户级 atk 配置目录（$HOME/.config/atk）。
 * @param {string} home 用户主目录，缺省取 os.homedir()
 * @returns {string} 配置目录绝对路径
 */
export function configDir(home = os.homedir()) {
  return path.join(home, '.config', 'atk');
}

/**
 * 用户级注册表文件路径。
 * @param {string} home 主目录
 * @returns {string} collections.json 绝对路径
 */
export function registryPath(home = os.homedir()) {
  return path.join(configDir(home), 'collections.json');
}

/**
 * 空注册表结构（首次运行 / 文件不存在时的默认值）。
 * @returns {object} { version, collections, defaults }
 */
export function defaultRegistry() {
  return { version: 1, collections: [], defaults: { disabled: [] } };
}

/**
 * 校验注册表对象（不读写文件）。
 * @param {*} registry 待校验的注册表数据
 * @returns {string[]} 错误列表（空数组=通过）
 */
export function validateRegistry(registry) {
  return validateSchema(registry, SCHEMAS.registry);
}

/**
 * 读取用户级注册表；文件不存在返回默认结构。
 * @param {string} home 主目录
 * @returns {Promise<object>} 注册表对象
 * @throws 文件存在但 JSON 非法或 schema 校验失败时抛出
 */
export async function loadRegistry(home = os.homedir()) {
  const file = registryPath(home);
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    // 文件不存在 = 首次使用，返回默认结构（F05/F22：首次运行从零开始）
    if (err.code === 'ENOENT') return defaultRegistry();
    throw err;
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`collections.json 解析失败（${file}）：${err.message}`);
  }
  const errors = validateRegistry(data);
  if (errors.length > 0) {
    throw new Error(`collections.json 校验失败（${file}）：\n${errors.join('\n')}`);
  }
  return data;
}

/**
 * 原子写入注册表：先校验（非法不落盘），再写临时文件后 rename 替换（F17 原子写）。
 * @param {string} home 主目录
 * @param {object} registry 注册表数据
 * @returns {Promise<string>} 写入的文件路径
 * @throws 校验失败/写盘失败时抛出，且不会留下半成品注册表
 */
export async function saveRegistry(home, registry) {
  const errors = validateRegistry(registry);
  if (errors.length > 0) {
    throw new Error(`collections.json 校验失败，拒绝写入：\n${errors.join('\n')}`);
  }
  const file = registryPath(home);
  await mkdir(path.dirname(file), { recursive: true });
  // 临时文件带 pid，避免并发进程互相踩踏；rename 同文件系统内为原子替换
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
  await rename(tmp, file);
  return file;
}

