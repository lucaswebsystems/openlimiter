const MIN_MAJOR = 24;
const MIN_MINOR = 13;
const active = process.versions.node;
const [major, minor] = active.split(".").map(Number);
const supported = major === MIN_MAJOR && minor >= MIN_MINOR;

if (!supported) {
  console.error(
    `OpenLimiter requires Node ${MIN_MAJOR}.${MIN_MINOR} or a newer ${MIN_MAJOR}.x release, ` +
      `but Node ${active} is active. Run "nvm install ${MIN_MAJOR}" and "nvm use ${MIN_MAJOR}", ` +
      'then rerun "pnpm install --frozen-lockfile".',
  );
  process.exitCode = 1;
}
