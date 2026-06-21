// dao 时间码 hook — UserPromptSubmit / Stop · 在消息前显示「说话者 · 时间戳」
//
// 注册事件:
//   UserPromptSubmit → 显示 "Frank · 15:22:30"
//   Stop             → 显示 "Claude · 15:22:32"
//
// 自包含,不依赖外部配置文件。
// 真相源:windsurf-dao/ccswitch/hooks/dao-timecode.js

const fs = require("fs");
const os = require("os");
const { execSync } = require("child_process");

const USERNAME = (() => {
  if (process.env.USER_DISPLAY_NAME) return process.env.USER_DISPLAY_NAME;
  try {
    const git = execSync("git config --global user.name", { encoding: "utf8" }).trim();
    if (git) return git;
  } catch {}
  return os.userInfo().username || "You";
})();

function formatTime(date) {
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function main() {
  let stdinData = {};
  try {
    stdinData = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {}

  const arg = (process.argv[2] || "").toLowerCase();
  let isUser;
  if (arg === "user" || arg === "userpromptsubmit") {
    isUser = true;
  } else if (arg === "claude" || arg === "stop") {
    isUser = false;
  } else {
    isUser = stdinData.prompt !== undefined;
  }

  const speaker = isUser ? USERNAME : "Claude";
  const message = `${speaker} · ${formatTime(new Date())}`;
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

main();
