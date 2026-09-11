import { attributedIssueNumber } from './close-issue.mjs';

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

export function canReleaseApprovedDraft({ pr, issue, greenAtHead, expectedHead }) {
  return !!(pr && issue && pr.isDraft === true && greenAtHead === true
    && expectedHead && pr.headRefOid === expectedHead
    && String(pr.mergeable).toUpperCase() === 'MERGEABLE'
    && attributedIssueNumber(pr) === Number(issue.number)
    && isApprovedExecutionTask(issue) && checksSucceeded(pr));
}
