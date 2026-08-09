const childProcess = require("node:child_process");

const originalExec = childProcess.exec;
childProcess.exec = function guardedExec(command, ...argumentsList) {
  if (command === "net use") {
    const callback = argumentsList.find((value) => typeof value === "function");
    if (callback !== undefined) {
      process.nextTick(() => callback(new Error("Unavailable"), "", ""));
      return { unref() {} };
    }
  }
  return originalExec.call(this, command, ...argumentsList);
};
