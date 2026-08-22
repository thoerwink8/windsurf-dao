function cmdWorkerDone(args) {
  const next = nextReviewerAfter({ currentId, models, passerIds, workerId });
  invokeReviewerCreate({ reviewer: next.next });
}
function cmdNotify() {}
