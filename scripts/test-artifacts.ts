import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

function canonical(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  return parent === absolute ? absolute : join(canonical(parent), relative(parent, absolute));
}
function contained(root: string, path: string): boolean {
  const child = relative(root, path);
  return child === "" || (!child.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && child !== ".." && !isAbsolute(child));
}
/** Keep generated outputs out of documentation/source trees, including through symlinks. */
export function artifactDirectory(projectRoot: string, requested: string): string {
  const root = realpathSync(projectRoot);
  const output = canonical(requested);
  if (contained(root, output) && !contained(join(root, "test-results"), output)) {
    throw new Error("Generated test output inside this repository must be under test-results/, not documentation, fixtures, or source directories.");
  }
  return output;
}
