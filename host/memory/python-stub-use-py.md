---
name: python-stub-use-py
description: "本机 python 是 WindowsApps stub(exit 49 静默失败),跑脚本一律用 py"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: b811bcf2-f463-4939-8023-4695788846e5
---

本机 `python` / `python3` 指向 `AppData/Local/Microsoft/WindowsApps/python` 的微软商店 stub —— 任何调用都静默 exit 49,**不报错也不执行**。真解释器是 py launcher(`py`,Python 3.12.10)。

**Why:** 用 `python search.py ...` 跑 dao-evolution 教训门控时会静默失败,输出为空,极易被误判成"教训库无命中"而跳过 HARD GATE(违反观相)。读 cc-switch.db 等一切 py 脚本同理。

**How to apply:** 这台机器上跑 Python 一律用 `py`(需要 utf8 输出加 `py -X utf8`)。看到某条命令 exit 49 且无输出,先怀疑是不是错调了 python stub。dao-evolution 搜索写成 `py search.py lessons "关键词"`。关联 [[dao-claude-migration]]。
