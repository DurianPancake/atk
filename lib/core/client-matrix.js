// client-matrix.js —— 客户端用户级目录单一配置源（M3 起仅用户级安装） by AI.Coding
//
// OpenCode/Codex 同时会外部扫描 ~/.claude/skills 与 ~/.agents/skills —— 本表不额外写入，避免重复副本。
// 说明：OpenCode 规范安装路径取单数（spike 确认 1.18.9 单复数皆可扫描）。

import path from 'node:path';
import os from 'node:os';

/**
 * 客户端能力矩阵：仅用户级目录（M2/M3：项目级目录已移除）。
 * 键为客户端规范名（state.json 的 client 字段枚举）。
 */
export const CLIENTS = {
  claude: {
    label: 'Claude Code',
    userDir: (home) => path.join(home, '.claude', 'skills'),
  },
  opencode: {
    label: 'OpenCode',
    userDir: (home) => path.join(home, '.config', 'opencode', 'skill'),
  },
  'cc-switch': {
    label: 'CC Switch',
    userDir: (home) => path.join(home, '.cc-switch', 'skills'),
  },
  codex: {
    label: 'Codex',
    userDir: (home) => path.join(home, '.agents', 'skills'),
  },
  dsh: {
    label: 'DSH',
    userDir: (home) => path.join(home, '.dsh', 'skills'),
  },
};

/**
 * 列出全部客户端名。
 * @returns {string[]} 客户端名数组（state.json client 枚举）
 */
export function clientNames() {
  return Object.keys(CLIENTS);
}

/**
 * 某客户端的用户级技能目录。
 * @param {string} client 客户端规范名
 * @param {string} home 主目录
 * @returns {string} 用户级技能目录绝对路径
 */
export function clientUserDir(client, home = os.homedir()) {
  const meta = CLIENTS[client];
  if (!meta) throw new Error(`未知客户端 "${client}"`);
  return meta.userDir(home);
}

