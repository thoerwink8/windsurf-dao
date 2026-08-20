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
