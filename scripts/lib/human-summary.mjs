// One human-facing summary for GitHub and Feishu.  Machine fields remain in
// the issue body, but people get the same STAR explanation everywhere:
// Situation, Task, Action, Result.
function str(v) { return v == null ? '' : String(v).trim(); }

function bodyField(body, label) {
  const m = String(body || '').match(new RegExp(`(?:^|\\n)-\\s*${label}：([^\\n]+)`, 'm'));
  return m ? str(m[1]) : '';
}

export function starFromIssue(issue = {}) {
  const body = str(issue.body);
  const situation = bodyField(body, '详情') || bodyField(body, '原因') || str(issue.title) || '有一项事情需要处理';
  const task = bodyField(body, '门类') || '现在需要决定下一步怎么做';
  const action = bodyField(body, '推荐项') || '先确认情况，再决定是否继续';
  const result = bodyField(body, '受影响')
    ? `处理对象：${bodyField(body, '受影响')}`
    : '拍板后会按选定方案继续，并把结果写回这张单';
  return { situation, task, action, result };
}

export function starText(star = {}) {
  return [
    `发生了什么：${str(star.situation) || '目前有一项事情需要处理'}`,
    `现在要决定：${str(star.task) || '下一步怎么做'}`,
    `建议怎么做：${str(star.action) || '先确认情况，再决定是否继续'}`,
    `会得到什么：${str(star.result) || '结果会写回这张单'}`,
  ].join('\n');
}
