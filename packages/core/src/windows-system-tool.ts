import path from "node:path";

const FALLBACK_WINDOWS_ROOT = "C:\\Windows";

/** Resolve one Windows supplied helper inside the operating system directory. */
export function windowsSystemTool(
  ...segmentsAndEnvironment: readonly (
    string | Readonly<Record<string, string | undefined>>
  )[]
): string {
  const possibleEnvironment = segmentsAndEnvironment.at(-1);
  const environment = typeof possibleEnvironment === "object"
    ? possibleEnvironment
    : process.env;
  const segments = typeof possibleEnvironment === "object"
    ? segmentsAndEnvironment.slice(0, -1) as readonly string[]
    : segmentsAndEnvironment as readonly string[];
  for (const segment of segments) {
    if (
      segment.length === 0 ||
      segment === "." ||
      segment === ".." ||
      path.win32.isAbsolute(segment) ||
      segment.includes("\\") ||
      segment.includes("/")
    ) {
      throw new Error("Invalid Windows system tool segment");
    }
  }
  const configuredRoot = environment["SystemRoot"] ?? environment["SYSTEMROOT"];
  const root = configuredRoot !== undefined && path.win32.isAbsolute(configuredRoot)
    ? configuredRoot
    : FALLBACK_WINDOWS_ROOT;
  return path.win32.join(root, "System32", ...segments);
}
