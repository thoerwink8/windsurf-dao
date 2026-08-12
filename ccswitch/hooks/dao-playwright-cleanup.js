#!/usr/bin/env node
// SessionStart hook: 清理残留的 Playwright MCP Chrome 进程和 lockfile
// 防止 "Browser is already in use" 阻塞整个会话
'use strict'

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const { pickPwsh } = require('../lib/pwsh.js')

const MCP_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
  'ms-playwright-mcp'
)

if (!fs.existsSync(MCP_DIR)) process.exit(0)

const entries = fs.readdirSync(MCP_DIR).filter(n => n.startsWith('mcp-chrome-'))
// issue #338：优先 pwsh、缺席回退 powershell 5.1（判定只看退出码，见 ../lib/pwsh.js 头注）
const PS = pickPwsh()

let cleaned = 0
for (const entry of entries) {
  const lockfile = path.join(MCP_DIR, entry, 'lockfile')
  if (!fs.existsSync(lockfile)) continue

  const udDir = path.join(MCP_DIR, entry)
  try {
    const psCmd = `${PS} -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${entry}*' } | Select-Object -ExpandProperty ProcessId"`
    const output = execSync(psCmd, { encoding: 'utf8', timeout: 8000 }).trim()

    if (output) {
      const pids = output.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s))
      for (const pid of pids) {
        try {
          execSync(`${PS} -NoProfile -Command "Stop-Process -Id ${pid} -Force -ErrorAction SilentlyContinue"`, { timeout: 3000 })
        } catch { /* ignore */ }
      }
      // 等进程退出释放 lockfile
      if (pids.length > 0) {
        execSync(`${PS} -NoProfile -Command "Start-Sleep -Milliseconds 500"`, { timeout: 3000 })
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
