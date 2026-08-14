// scripts/lib/yaml-min.mjs —— 点将台政策层 YAML 最小解析器
//
// 为什么自己写：仓里只 vendored 了 TOML（model-routing.toml 用），政策层按设计
// （docs/dianjiangtai-design.md A.1）是 YAML，且不引入外部依赖（离线仓库原则）。
// 支持子集（policy/ 下三个文件实际用到的结构，超集报错不静默猜）：
//   - 全行 / 行尾 # 注释（引号内 # 不算）
//   - 顶层与嵌套映射（2 空格缩进约定；跳级报错）
//   - 数组：`- key: value` 列表项（项内可再嵌套映射）；内联流式 `[a, b]`
//   - 标量：字符串（可引号）、数字、true/false、null/~
//   - 多行块标量（| / >）：明确不支持，出现即报错（避免静默吞内容）
// 注意：本解析器只服务于 policy/ 层的选型输入，不是通用 YAML 引擎。

let pos = 0;
let lines = [];

export function parseYaml(text) {
  lines = text
    .split(/\r?\n/)
    .map((raw, i) => ({ raw, line: i + 1 }))
    .map(({ raw, line }) => {
      const stripped = stripComment(raw);
      const indent = (stripped.match(/^ */) || [''])[0].length;
      return { indent, text: stripped.trim(), line };
    })
    .filter(l => l.text.length > 0);

  pos = 0;
  const root = {};
  while (pos < lines.length) {
    if (lines[pos].indent !== 0) throw yamlError(lines[pos], '顶层不允许缩进');
    const value = parseMapOrList(0);
    if (value && typeof value === 'object' && !Array.isArray(value)) Object.assign(root, value);
    else throw yamlError(lines[pos], '顶层必须是映射');
  }
  return root;
}

function yamlError(line, msg) {
  return new Error(`YAML 解析失败 line ${line.line}: ${msg}（原文: ${line.raw}）`);
}

function stripComment(s) {
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '#' && !inS && !inD) return s.slice(0, i);
  }
  return s;
}

// 读一个同缩进层级的内容：若首行是列表项则整个块是数组，否则是映射。
function parseMapOrList(indent) {
  if (pos >= lines.length) return null;
  if (lines[pos].indent !== indent) {
    if (lines[pos].indent < indent) return null;
    throw yamlError(lines[pos], `缩进跳级：期望 ${indent}，实际 ${lines[pos].indent}`);
  }
  if (lines[pos].text.startsWith('- ')) return parseList(indent);
  return parseMap(indent);
}

function parseMap(indent) {
  const obj = {};
  while (pos < lines.length && lines[pos].indent === indent && !lines[pos].text.startsWith('- ')) {
    const line = lines[pos];
    const m = line.text.match(/^([^:]+):\s*(.*)$/);
    if (!m) throw yamlError(line, `不是「key: value」形态`);
    const key = unquote(m[1].trim());
    const rest = m[2].trim();
    pos++;
    if (rest === '') {
      if (pos < lines.length && lines[pos].indent > indent) obj[key] = parseMapOrList(lines[pos].indent);
      else obj[key] = null;
    } else if (rest === '|' || rest.startsWith('| ') || rest === '>' || rest.startsWith('> ')) {
      throw yamlError(line, `多行块标量不支持（policy/ 子集外）`);
    } else {
      obj[key] = scalar(rest);
    }
  }
  return obj;
}

function parseList(indent) {
  const arr = [];
  while (pos < lines.length && lines[pos].indent === indent && lines[pos].text.startsWith('- ')) {
    const line = lines[pos];
    const rest = line.text.slice(2).trim();
    pos++;
    if (rest === '') {
      arr.push(pos < lines.length && lines[pos].indent > indent ? parseMapOrList(lines[pos].indent) : null);
      continue;
    }
    const m = rest.match(/^([^:]+):\s*(.*)$/);
    if (!m) { arr.push(scalar(rest)); continue; }
    const key = unquote(m[1].trim());
    const val = m[2].trim();
    const item = {};
    if (val === '') {
      item[key] = pos < lines.length && lines[pos].indent > indent ? parseMapOrList(lines[pos].indent) : null;
    } else {
      item[key] = scalar(val);
    }
    // 列表项后续更深的行属于该项的扩展字段（如 pricing 嵌在模型条目下）
    if (pos < lines.length && lines[pos].indent > indent) {
      Object.assign(item, parseMapOrList(lines[pos].indent));
    }
    arr.push(item);
  }
  if (arr.length === 0) throw yamlError(lines[pos], '列表项后没有内容');
  return arr;
}

function scalar(s) {
  if (s === 'null' || s === '~' || s === '') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map(x => scalar(x.trim()));
  }
  if (s.startsWith('{') && s.endsWith('}')) {
    const inner = s.slice(1, -1).trim();
    if (inner === '') return {};
    const obj = {};
    for (const pair of inner.split(',')) {
      const idx = pair.indexOf(':');
      if (idx < 0) throw new Error(`YAML 内联映射无法解析: ${s}`);
      obj[unquote(pair.slice(0, idx).trim())] = scalar(pair.slice(idx + 1).trim());
    }
    return obj;
  }
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return unquote(s);
}

function unquote(s) {
  if (s.length >= 2 && ((s[0] === '"' && s.endsWith('"')) || (s[0] === "'" && s.endsWith("'")))) {
    return s.slice(1, -1);
  }
  return s;
}
