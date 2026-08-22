// 绿样本：引用的目标都在
const path = require('path');
const LIB = path.join(__dirname, '..', 'scripts', 'lib', 'alive.mjs');
const LIB_LOAD = import('file://' + LIB);
const { helper } = require('../scripts/lib/also-alive.js');
