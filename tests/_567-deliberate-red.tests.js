// #567 验收实验：故意红样本（临时，验完即撤）。
// 用途：验证「push 事件能触发 check 并当场报红」这个机制本身——
// 判据核心是 run 的事件类型是 push、结论是 failure、红的是这一条。
process.stdout.write('FAIL #567 故意红：这是验证 push 触发机制的一次性样本（验完即撤）\n');
process.exit(1);