const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fileURLToPath } = require("node:url");
const { syncBuiltinESMExports } = require("node:module");
const { promisify } = require("node:util");

// A missing dependency or a HOME-only override must never select the real
// Windows profile. Fail closed before loading any test or installed CLI copy.
const workspace = fs.realpathSync(path.resolve(__dirname, ".."));
const realHome = fs.realpathSync(os.userInfo().homedir);
const within = (root, target) => {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
};
const originalRealpath = fs.realpathSync.native;
function canonical(target) {
  try { return originalRealpath(target); }
  catch (error) {
    if (error.code !== "ENOENT" && error.code !== "ENOTDIR") throw error;
    const parent = path.dirname(target);
    if (parent === target) throw error;
    return path.join(canonical(parent), path.basename(target));
  }
}
const scratchParent = path.join(workspace, ".test-dist");
fs.mkdirSync(scratchParent, { recursive: true });
const inheritedSandbox = process.env.OPENLIMITER_TEST_SANDBOX;
const sandbox = inheritedSandbox || fs.mkdtempSync(path.join(scratchParent, "test-home-"));
if (!within(workspace, canonical(path.resolve(sandbox)))) throw new Error("Test sandbox must stay inside the worktree");
fs.mkdirSync(sandbox, { recursive: true });
process.env.OPENLIMITER_TEST_SANDBOX = sandbox;
const homeVariables = ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "TMP", "TEMP", "TMPDIR"];
for (const variable of homeVariables) {
  if (!inheritedSandbox || !process.env[variable]) process.env[variable] = sandbox;
}
// Provider overrides can otherwise redirect a correctly isolated home.
if (!inheritedSandbox) {
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
}

const violationFile = path.join(sandbox, "home-write-violations.log");
const recordViolation = fs.appendFileSync;
const exists = fs.existsSync;
process.on("exit", () => {
  if (exists(violationFile)) {
    process.stderr.write("Test isolation failed: a write to the real home was blocked.\n");
    process.exitCode = 1;
  }
});
function guard(target, followFinal = true) {
  if (typeof target === "number" || target === undefined) return;
  if (target instanceof URL) target = fileURLToPath(target);
  if (Buffer.isBuffer(target)) target = target.toString();
  if (typeof target !== "string") return;
  const absolute = path.resolve(target);
  // Removing or replacing a link changes its directory entry, not its target.
  // In particular, Windows realpath rejects a junction after its target is gone.
  const resolved = followFinal ? canonical(absolute)
    : path.join(canonical(path.dirname(absolute)), path.basename(absolute));
  // The repository itself lives under the profile; only that worktree is
  // writable. Temp files are redirected inside it, never to real AppData.
  if (within(realHome, resolved) && !within(workspace, resolved)) {
    const error = new Error(`Test isolation blocked real home write: ${resolved}`);
    recordViolation(violationFile, error.stack + "\n");
    throw error;
  }
}
const mutations = {
  writeFile: [0], appendFile: [0], mkdir: [0], mkdtemp: [0], rm: [0], rmdir: [0],
  unlink: [0], rename: [0, 1], copyFile: [1], cp: [1], link: [1], symlink: [1],
  chmod: [0], chown: [0], lchmod: [0], lchown: [0], utimes: [0], lutimes: [0], truncate: [0]
};
const entryMutations = new Set(["rm", "rmdir", "unlink", "rename", "symlink", "lchmod", "lchown", "lutimes"]);
for (const [name, indices] of Object.entries(mutations)) {
  for (const [object, method] of [[fs, name], [fs, name + "Sync"], [fs.promises, name]]) {
    if (typeof object[method] !== "function") continue;
    const original = object[method];
    object[method] = function (...args) {
      for (const index of indices) guard(args[index], !entryMutations.has(name));
      if (name === "link") {
        const source = canonical(path.resolve(args[0] instanceof URL ? fileURLToPath(args[0]) : String(args[0])));
        if (within(realHome, source) && !within(workspace, source)) {
          // Linking is not a write to the source, but sharing its inode would
          // allow later writes through the fixture. Request the normal copy
          // fallback without recording a home write that never happened.
          const error = Object.assign(new Error("Test isolation requires copying a real home source"), { code: "EXDEV" });
          if (object === fs.promises) return Promise.reject(error);
          if (method === "link") return process.nextTick(args.at(-1), error);
          throw error;
        }
      }
      return original.apply(this, args);
    };
  }
}
const writes = flags => typeof flags === "number"
  ? (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND)) !== 0
  : /[wa+]/u.test(flags ?? "r");
for (const [object, name] of [[fs, "open"], [fs, "openSync"], [fs.promises, "open"]]) {
  const original = object[name];
  object[name] = function (target, flags, ...rest) {
    if (writes(flags)) guard(target);
    return original.call(this, target, flags, ...rest);
  };
}
const originalStream = fs.createWriteStream;
fs.createWriteStream = function (target, ...rest) {
  guard(target);
  return originalStream.call(this, target, ...rest);
};

// Shell launchers and copied Node runtimes inherit the same isolated profile.
// Explicit child env objects must not silently drop the Node write guard.
for (const name of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const original = childProcess[name];
  childProcess[name] = function (command, ...args) {
    let index = Array.isArray(args[0]) ? 1 : 0;
    const options = args[index] && typeof args[index] === "object" ? args[index] : {};
    const env = { ...(options.env ?? process.env) };
    for (const variable of homeVariables) env[variable] ??= sandbox;
    for (const variable of [...homeVariables, "CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
      if (env[variable]) guard(env[variable]);
    }
    env.OPENLIMITER_TEST_SANDBOX = options.env?.OPENLIMITER_TEST_SANDBOX || sandbox;
    const preload = `--require ${JSON.stringify(__filename)}`;
    env.NODE_OPTIONS = (env.NODE_OPTIONS || "").includes(__filename) ? env.NODE_OPTIONS : `${env.NODE_OPTIONS || ""} ${preload}`.trim();
    if (args[index] && typeof args[index] === "object") args[index] = { ...options, env };
    else args.splice(index, 0, { env });
    return original.call(this, command, ...args);
  };
}
syncBuiltinESMExports();

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
// Node's exec APIs have a custom Promise contract. Rebuild it around the
// guarded functions; copying Node's original custom function bypasses isolation.
for (const name of ["exec", "execFile"]) {
  childProcess[name][promisify.custom] = (...args) => {
    let child;
    const promise = new Promise((resolve, reject) => {
      child = childProcess[name](...args, (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      });
    });
    promise.child = child;
    return promise;
  };
}
syncBuiltinESMExports();
