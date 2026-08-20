const required = "24.15.0";
const active = process.versions.node;

if (active !== required) {
  console.error(
    `OpenLimiter requires Node ${required}, but Node ${active} is active. ` +
      `Run "nvm install ${required}" and "nvm use ${required}", then rerun ` +
      '"pnpm install --frozen-lockfile".',
  );
  process.exitCode = 1;
}
