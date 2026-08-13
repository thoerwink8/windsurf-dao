#!/usr/bin/env node
// SessionStart hook: 清理残留的 Playwright MCP Chrome 进程和 lockfile
// 防止 "Browser is already in use" 阻塞整个会话
'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { pickPwsh } = require('../lib/pwsh.js')

const MCP_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
  'ms-playwright-mcp'
)

if (!fs.existsSync(MCP_DIR)) process.exit(0)

const entries = fs.readdirSync(MCP_DIR).filter(n => n.startsWith('mcp-chrome-'))
// issue #338：优先 pwsh、缺席回退 powershell 5.1（判定只看退出码，见 ../lib/pwsh.js 头注）。
// issue #387 挂账 4：三态探测下 PS 可能是带空格的绝对路径（`C:\Program Files\...`）——
// 字符串插值拼进 execSync 的命令行不加引号会被 cmd.exe 拆成多个 token 而崩，改用
// execFileSync 数组参数，PS 本身不再经过 shell 解析，天然不受空格影响。
const PS = pickPwsh()

let cleaned = 0
for (const entry of entries) {
  const lockfile = path.join(MCP_DIR, entry, 'lockfile')
  if (!fs.existsSync(lockfile)) continue

  const udDir = path.join(MCP_DIR, entry)
  try {
    const filterScript = `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${entry}*' } | Select-Object -ExpandProperty ProcessId`
    const output = execFileSync(PS, ['-NoProfile', '-Command', filterScript], { encoding: 'utf8', timeout: 8000 }).trim()

    if (output) {
      const pids = output.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s))
      for (const pid of pids) {
        try {
          execFileSync(PS, ['-NoProfile', '-Command', `Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue`], { timeout: 3000 })
        } catch { /* ignore */ }
      }
      // 等进程退出释放 lockfile
      if (pids.length > 0) {
        execFileSync(PS, ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { timeout: 3000 })
      }
    }
  } catch { /* PS 失败不阻塞 */ }

  try {
    fs.unlinkSync(lockfile)
    cleaned++
  } catch { /* 被占用则跳过 */ }
}

if (cleaned > 0) {
  process.stderr.write(`[dao-playwright-cleanup] 清理了 ${cleaned} 个残留 Playwright 锁\n`)
}
