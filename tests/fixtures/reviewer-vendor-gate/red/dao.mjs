function cmdDispatch(args) {
  const launched = startWorkerBySlate();
  plan.model = launched.modelId;
}
function cmdReviewerCreate(args) {
  const picked = resolveReviewerFromPr({ pr: args.pr });
}
function cmdReviewerAttach(args) {
  resolveLaunch({ model: args.reviewer });
}
function cmdWorkerDone(args) {
  invokeReviewerCreate({ pr: args.pr, dryRun: false });
  nextReviewerAfter({ currentId, models, passerIds, workerId });
}
function cmdNotify() {}
