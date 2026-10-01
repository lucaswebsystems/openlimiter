import { stat } from "node:fs/promises";
import path from "node:path";

const FALLBACK_WINDOWS_ROOT = "C:\\Windows";

function validToolSegment(segment: string): boolean {
  return segment.length > 0 &&
    segment !== "." &&
    segment !== ".." &&
    !path.win32.isAbsolute(segment) &&
    !segment.includes("\\") &&
    !segment.includes("/");
}

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
    if (!validToolSegment(segment)) {
      throw new Error("Invalid Windows system tool segment");
    }
  }
  const configuredRoot = environment["SystemRoot"] ?? environment["SYSTEMROOT"];
  const root = configuredRoot !== undefined && path.win32.isAbsolute(configuredRoot)
    ? configuredRoot
    : FALLBACK_WINDOWS_ROOT;
  return path.win32.join(root, "System32", ...segments);
}

/** Resolve a helper from absolute PATH entries without consulting the cwd. */
export async function windowsPathTool(
  program: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  isFile: (candidate: string) => Promise<boolean> = async (candidate) =>
    (await stat(candidate)).isFile(),
  currentDirectory: string = process.cwd()
): Promise<string | null> {
  if (!validToolSegment(program)) {
    throw new Error("Invalid Windows PATH tool name");
  }
  const pathText = Object.entries(environment).find(
    ([key]) => key.toLowerCase() === "path"
  )?.[1] ?? "";
  const normalizedCurrentDirectory = path.win32.resolve(currentDirectory).toLowerCase();
  for (const rawDirectory of pathText.split(path.win32.delimiter)) {
    const directory = rawDirectory.startsWith('"') && rawDirectory.endsWith('"')
      ? rawDirectory.slice(1, -1)
      : rawDirectory;
    // Empty and relative entries ask Windows to search relative to the cwd.
    if (
      !path.win32.isAbsolute(directory) ||
      path.win32.resolve(directory).toLowerCase() === normalizedCurrentDirectory
    ) continue;
    const candidate = path.win32.join(directory, program);
    try {
      if (await isFile(candidate)) return candidate;
    } catch {
      // One inaccessible or missing PATH entry does not hide later entries.
    }
  }
  return null;
}
