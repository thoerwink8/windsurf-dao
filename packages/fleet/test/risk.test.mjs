// T34：风险分层判据。纯函数喂样本——严格程度正比于爆炸半径。
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyRisk, tierPlan, isDocFile, isMechanismFile } from '../src/risk.mjs';

describe('T34：风险分层', () => {
  it('T0：全是文档/注释', () => {
    assert.equal(classifyRisk({ files: ['docs/a.md', 'README.md', 'docs/notes/b.txt'] }), 'T0');
    assert.equal(isDocFile('docs/x.mdx'), true);
  });

  it('T2：碰机制/协议/安全（含规则类文档）', () => {
    for (const f of ['scripts/lib/gh.mjs', 'host/machine/systemd/dao-x.service', 'host/machine/sudoers.d/dao-sync',
      'packages/fleet/src/workflows.mjs', 'CLAUDE.md', 'docs/release-policy.json', 'scripts/lib/token-refresh.mjs']) {
      assert.equal(classifyRisk({ files: [f] }), 'T2', f);
    }
    assert.equal(isMechanismFile('scripts/lib/a.mjs'), true);
  });

  it('T1：孤立代码（不碰机制/协议/安全）', () => {
    assert.equal(classifyRisk({ files: ['src/thing.js', 'app/components/Button.tsx'] }), 'T1');
  });

  it('混合：只要有一个 T2 文件，整单按 T2', () => {
    assert.equal(classifyRisk({ files: ['docs/a.md', 'scripts/lib/gh.mjs'] }), 'T2');
    assert.equal(classifyRisk({ files: ['docs/a.md', 'src/x.js'] }), 'T1');
  });

  it('没查成（空/非数组）→ null，调用方按 T2 保守走', () => {
    assert.equal(classifyRisk({ files: [] }), null);
    assert.equal(classifyRisk({}), null);
    assert.equal(classifyRisk(null), null);
    assert.equal(classifyRisk({ files: [null, ''] }), null);
  });

  it('tierPlan：T0 不审 / T1 只异厂 / T2 全流程；没查成按 T2', () => {
    assert.deepEqual(tierPlan('T0'), { selfReview: false, review: false });
    assert.deepEqual(tierPlan('T1'), { selfReview: false, review: true });
    assert.deepEqual(tierPlan('T2'), { selfReview: true, review: true });
    assert.deepEqual(tierPlan(null), { selfReview: true, review: true });
  });
});
