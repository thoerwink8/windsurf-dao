import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const cwd = process.argv[2];
process.on('SIGTERM', () => {});
if (process.argv[3] !== 'grandchild') {
  // This child escapes the agent's process group; the runtime must track the subtree too.
  const grandchild = spawn(process.execPath, [new URL(import.meta.url).pathname, cwd, 'grandchild'], { detached: true, stdio: 'ignore' });
  fs.writeFileSync(path.join(cwd, 'subtree.json'), JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
}
setInterval(() => {}, 1000);
