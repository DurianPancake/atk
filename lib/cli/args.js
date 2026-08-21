// args.js —— 极简命令行参数解析 by AI.Coding
//
// 支持两种形态：--flag 布尔开关（须在 allowedFlags 白名单）；--key <值> 选项（取后一个参数）。
// 其余参数归入 positional。未知 -- 前缀参数报错（W3/R7 收口：--project 等旧选项与拼错不再静默忽略）。

/**
 * 解析参数。
 * @param {string[]} argv 参数数组（不含命令名）
 * @param {string[]} [valueKeys] 需要取值的选项名（如 ["--scope"]）
 * @param {string[]} [allowedFlags] 允许的布尔标志名（不含 valueKeys；未知 -- 选项报错）
 * @returns {{ flags: Set<string>, options: object, positional: string[] }} 解析结果
 * @throws 遇到未知 -- 选项或取值选项缺值时抛出
 */
export function parseArgs(argv, valueKeys = [], allowedFlags = []) {
  const flags = new Set();
  const options = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      if (valueKeys.includes(arg)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new Error(`选项 ${arg} 缺少值`);
        }
        options[arg.slice(2)] = value;
        i += 1;
      } else if (allowedFlags.includes(arg)) {
        flags.add(arg.slice(2));
      } else {
        throw new Error(`未知选项：${arg}（可用选项见 atk --help）`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, options, positional };
}