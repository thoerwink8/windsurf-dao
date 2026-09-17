import { attributedIssueNumbers } from './close-issue.mjs';

export function explicitApprovalIssue(pr) {
  const numbers = attributedIssueNumbers(pr?.body || '').filter(n => n > 0);
  return numbers.length === 1 ? numbers[0] : null;
}

export function isApprovedExecutionTask(issue) {
  if (!Array.isArray(issue?.labels)) return false;
  const labels = issue.labels.map(l => typeof l === 'string' ? l : l?.name);
  return labels.includes('已拍板') && labels.includes('已消歧');
}

export function checksSucceeded(pr) {
  const checks = pr?.statusCheckRollup;
  return Array.isArray(checks) && checks.length > 0 && checks.every(c =>
    c && c.conclusion === 'SUCCESS' && c.status === 'COMPLETED');
}

function approvalBound({ pr, issue, greenAtHead, expectedHead, requireDraft }) {
  return !!(pr && issue && greenAtHead === true
    && expectedHead && pr.headRefOid === expectedHead
    && String(pr.mergeable).toUpperCase() === 'MERGEABLE'
    && explicitApprovalIssue(pr) === Number(issue.number)
    && isApprovedExecutionTask(issue) && checksSucceeded(pr)
    && (requireDraft ? pr.isDraft === true : true));
}

export function canReleaseApprovedDraft({ pr, issue, greenAtHead, expectedHead }) {
  return approvalBound({ pr, issue, greenAtHead, expectedHead, requireDraft: true });
}

/** 非 draft 的 m=manual：证据与 draft 路相同，但不要求 isDraft。
 *  不能复用 canReleaseApprovedDraft——那条要求 isDraft === true，吃不掉 #1218。 */
export function canReleaseApprovedManual({ pr, issue, greenAtHead, expectedHead }) {
  return approvalBound({ pr, issue, greenAtHead, expectedHead, requireDraft: false });
}
