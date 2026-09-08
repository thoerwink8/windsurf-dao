// 飞书卡片 → 纯文本：卡片被拒收时的最后送达路径。

export function cardToPlainText(card) {
  const parts = [];
  const visit = (value) => {
    if (value == null) return;
    if (typeof value === 'string') return;
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (typeof value !== 'object') return;
    if (typeof value.content === 'string'
      && (value.tag === 'plain_text' || value.tag === 'lark_md' || value.tag === 'markdown')) {
      const content = value.content.replace(/\s+/g, ' ').trim();
      if (content) parts.push(content);
    }
    Object.entries(value).forEach(([key, child]) => {
      if (key !== 'content') visit(child);
    });
  };
  visit(card);
  const unique = [...new Set(parts)];
  return (unique.join('\n') || '指挥官有一条通知，但卡片格式被飞书拒收，请查看服务器日志。').slice(0, 6000);
}
