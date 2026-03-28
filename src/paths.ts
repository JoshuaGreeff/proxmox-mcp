import path from "node:path";
import { fileURLToPath } from "node:url";

/** Returns the repo/app root when called from a compiled file under `dist/` or source under `src/`. */
export function getAppRoot(importMetaUrl: string): string {
  return path.resolve(path.dirname(fileURLToPath(importMetaUrl)), "..");
}

/** Resolves an absolute path or treats a relative path as rooted under the app root. */
export function resolveFromAppRoot(appRoot: string, targetPath: string): string {
  return path.isAbsolute(targetPath) ? targetPath : path.resolve(appRoot, targetPath);
}
