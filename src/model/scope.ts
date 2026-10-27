import type { ProjectShell } from "../t3/types.ts";

// The T3 Code sidebar can be filtered to one project. Its key is a logical
// project key (client-runtime projectGrouping.ts): the repository's canonical
// key by default, `<repo>::<subdir>` in per-folder grouping, `<env>:<path>` for
// separate or non-repository projects, or a reserved key for "No project".

export const SCRATCH_SCOPE_KEY = "\0no-project";

const normalizePath = (path: string) => path.trim().replace(/[\\/]+$/, "");

/** Every key the sidebar could use for this project, whatever its grouping mode. */
export function projectScopeKeys(
  environmentId: string,
  project: ProjectShell,
  scratchWorkspaceRoot: string | null,
): Set<string> {
  const root = normalizePath(project.workspaceRoot);
  const keys = new Set([`${environmentId}:${root}`, `${environmentId}:${project.id}`]);
  const identity = project.repositoryIdentity;
  const repoKey = identity ? (identity.origin?.canonicalKey ?? identity.canonicalKey) : null;
  if (repoKey) {
    keys.add(repoKey);
    const repoRoot = identity?.rootPath ? normalizePath(identity.rootPath) : null;
    if (repoRoot && root.startsWith(`${repoRoot}/`)) {
      keys.add(`${repoKey}::${root.slice(repoRoot.length + 1)}`);
    }
  }
  if (scratchWorkspaceRoot && root === normalizePath(scratchWorkspaceRoot)) {
    keys.add(SCRATCH_SCOPE_KEY);
  }
  return keys;
}
