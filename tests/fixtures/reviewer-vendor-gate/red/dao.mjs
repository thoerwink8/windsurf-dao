function cmdReviewerCreate(args) {
  const picked = resolveReviewerFromPr({ pr: args.pr });
}
function cmdReviewerAttach(args) {
  resolveLaunch({ model: args.reviewer });
}
function cmdWorkerDone(args) {
  invokeReviewerCreate({ pr: args.pr, dryRun: false });
}
function cmdNotify() {}
