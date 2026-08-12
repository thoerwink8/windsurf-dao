import assert from "node:assert/strict";
import { probe, probePi, summarize } from "../scripts/dao-roster.mjs";

function fake(result) { return () => ({ ...result }); }

assert.deepEqual(probe("pi", ["--version"], 4000, fake({ status: 0, stdout: "0.84.1\n" })), {
  available: true, version: "0.84.1",
});
assert.deepEqual(probe("missing", ["--version"], 4000, fake({ status: 1, stdout: "", stderr: "not found" })), {
  available: false,
});
assert.deepEqual(probe("slow", ["--version"], 4000, fake({ error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null })), {
  available: "unknown",
});
assert.deepEqual(probe("broken", ["--version"], 4000, () => { throw Object.assign(new Error("spawn failed"), { code: "EACCES" }); }), {
  available: "unknown",
});

let attempts = 0;
const retrySpawn = () => {
  attempts += 1;
  return attempts === 1
    ? { error: Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }), status: null }
    : { status: 0, stdout: "0.84.1\n" };
};
assert.equal(probe("pi", ["--version"], 4000, retrySpawn).available, true);
assert.equal(attempts, 2);

assert.equal(probePi().available, true, "pi 在本机必须为 true");

assert.equal(summarize({ orca: { available: "unknown" } }, { pi: { available: true }, claude: { available: false }, codex: { available: "unknown" } }), "fabric=orca? agents=pi✓,claude✗,codex?");
console.log("dao-roster tests: 6 passed");
