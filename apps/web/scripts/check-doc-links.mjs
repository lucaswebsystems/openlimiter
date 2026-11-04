export * from "./check-links.mjs";
const mod = await import("./check-links.mjs");
export default mod.default;
import { pathToFileURL } from "node:url";
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await mod.default();
  if (process.exitCode) process.exit(process.exitCode);
}
