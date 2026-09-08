const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const LIB = import('../scripts/lib/broadcast-io.mjs');

describe('飞书卡片发送降级', () => {
  it('卡片文本抽取只保留可读节点', async () => {
    const { cardToPlainText } = await LIB;
    const text = cardToPlainText({
      header: { title: { tag: 'plain_text', content: '待拍板：dao#1' } },
      elements: [{ tag: 'div', text: { tag: 'lark_md', content: '出了什么事：卡片失败' } }],
    });
    assert.match(text, /待拍板：dao#1/);
    assert.match(text, /出了什么事：卡片失败/);
  });

  it('交互卡片被拒收 → 发送纯文本且标记 degraded', async () => {
    const { sendCardViaLark } = await LIB;
    const calls = [];
    const spawn = (cmd, argv) => {
      calls.push([cmd, ...argv]);
      if (calls.length === 1) return { status: 1, stderr: 'card content rejected', stdout: '' };
      return { status: 0, stdout: '{"data":{"message_id":"om_fallback"}}', stderr: '' };
    };
    const r = sendCardViaLark({
      chatId: 'oc_hub',
      card: { elements: [{ tag: 'div', text: { tag: 'lark_md', content: '关键通知' } }] },
      spawn,
    });
    assert.equal(r.ok, true);
    assert.equal(r.degraded, true);
    assert.equal(calls.length, 2);
    assert.ok(calls[1].includes('--text'));
  });
});
