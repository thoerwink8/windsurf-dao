function cmdWorkerDone(args) {
  const stop = planReviewerCreateAfterFail({ error: create.error });
  fail(stop.error, { switchVendor: false });
}
function cmdNotify() {}
