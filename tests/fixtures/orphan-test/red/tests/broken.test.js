// 红样本：引用了不存在的仓内目标（机制已删，测试没同删）
const path = require('path');
const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'deleted-mechanism.mjs');
const LIB_LOAD = import('file://' + LIB);
const { helper } = require('../scripts/lib/also-gone.js');
