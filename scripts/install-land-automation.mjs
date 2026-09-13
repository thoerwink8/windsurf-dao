#!/usr/bin/env node
// land 的装法已经换成 systemd（orca automations 随产品退役）。
// 本文件留着是为了老调用 `node scripts/install-land-automation.mjs` 还能找到路。
import { LAND_INSTALL, LAND_TIMER } from './lib/land-automation.mjs';

console.error(`orca automations 已退役。装 ${LAND_TIMER}：${LAND_INSTALL}`);
process.exit(2);
