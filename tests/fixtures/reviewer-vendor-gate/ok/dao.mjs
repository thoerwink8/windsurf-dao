function cmdDispatch(args) {
  filterSlateSameVendor({ slate, reviewerId, models });
  const launched = startWorkerBySlate();
  refuseIfSameVendor({ workerId: launched.modelId, reviewerId, routing });
  const childLaunch = startWorkerBySlate();
  refuseIfSameVendor({ workerId: childLaunch.modelId, reviewerId, routing });
}
function cmdReviewerCreate(args) {
  refuseIfSameVendor({ workerId, reviewerId, routing });
}
function cmdReviewerAttach(args) {
  refuseIfSameVendor({ workerId, reviewerId, routing });
}
function cmdWorkerDone(args) {
  refuseIfSameVendor({ workerId, reviewerId, routing });
  nextReviewerAfter({ currentId, models, passerIds, workerId });
}
function cmdNotify() {}
