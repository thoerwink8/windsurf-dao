function executeCapacitySwitch(target, args, events) {
  const parsed = parseWorkerModelFromCard(parent?.displayName);
  const plan = planCapacitySwitch({ displayName: target.name, workerId: parsed.model });
}
function leftover() {}
