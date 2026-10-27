import type { SlotStatus } from "../device/lighting.ts";
import type { ProjectShell, ThreadShell } from "../t3/types.ts";
import { projectScopeKeys } from "./scope.ts";

export const SLOT_COUNT = 6;

/** Thread ids are only unique per environment. */
export interface ThreadRef {
  readonly environmentId: string;
  readonly threadId: string;
}

export interface ScopedThread extends ThreadRef {
  readonly thread: ThreadShell;
  /** A subagent under this thread is waiting on the user. */
  readonly childNeedsInput: boolean;
}

export interface Slot {
  readonly index: number;
  readonly ref: ThreadRef | null;
  readonly title: string | null;
  readonly status: SlotStatus;
}

export const EMPTY_SLOTS: ReadonlyArray<Slot> = Array.from({ length: SLOT_COUNT }, (_, index) => ({
  index,
  ref: null,
  title: null,
  status: "off",
}));

export const sameRef = (a: ThreadRef | null | undefined, b: ThreadRef | null | undefined) =>
  !!a && !!b && a.environmentId === b.environmentId && a.threadId === b.threadId;

export const refKey = (ref: ThreadRef) => `${ref.environmentId}/${ref.threadId}`;

const LIVE = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/** The thread's runtime status as T3 Code's sidebar derives it (client-runtime models.ts). */
function runtimeStatus(thread: ThreadShell): string | null {
  if (thread.latestRunId === null && thread.activeProviderThreadId === null) return null;
  return thread.activityRunStatus ?? thread.status;
}

export function hasPendingApproval(thread: ThreadShell): boolean {
  const kind = thread.pendingRuntimeRequest?.kind;
  return kind !== undefined && kind !== "user_input" && kind !== "auth_refresh";
}

export function isWorking(thread: ThreadShell): boolean {
  const status = runtimeStatus(thread);
  return status !== null && LIVE.has(status);
}

/**
 * The sidebar's status (Sidebar.logic.ts `resolveSidebarThreadStatus`)
 * folded into the device's colours, as in the Codex app:
 * error > needs input > working > unread (done) > idle.
 */
export function threadStatus(thread: ThreadShell, childNeedsInput = false): SlotStatus {
  const runtime = runtimeStatus(thread);
  const working = runtime === "preparing" || runtime === "starting" || runtime === "running";
  if (hasPendingApproval(thread)) return "needs-input";
  if (
    thread.pendingRuntimeRequest?.kind === "user_input" &&
    (thread.pendingRuntimeRequest.blocking !== false || !working)
  ) {
    return "needs-input";
  }
  if (childNeedsInput || (thread.pendingGuestMessageCount ?? 0) > 0) return "needs-input";
  if (runtime === "running" && thread.blockedOnThreadWait === true) return "working";
  if (runtime !== null && LIVE.has(runtime)) return "working";
  if (runtime === "failed") return "error";
  if (hasUnseenCompletion(thread)) return "done";
  return "idle";
}

/** Finished after the user last looked (Sidebar.logic.ts `hasUnseenCompletion`). */
export function hasUnseenCompletion(thread: ThreadShell): boolean {
  if (!thread.latestRunCompletedAt || !thread.lastVisitedAt) return false;
  const completedAt = Date.parse(thread.latestRunCompletedAt);
  const visitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt)) return false;
  return Number.isNaN(visitedAt) || completedAt > visitedAt;
}

export interface CandidateSource {
  readonly environmentId: string;
  readonly threads: Iterable<ThreadShell>;
  readonly projects?: Iterable<ProjectShell>;
  readonly scratchWorkspaceRoot?: string | null;
}

export interface CandidateOptions {
  /** The sidebar's project filter key, or null for every project. */
  readonly scope?: string | null;
  /** Leave out settled threads unless they're working or need you, as the sidebar does. */
  readonly hideSettled?: boolean;
}

/**
 * Threads that can go on a key: visible top-level threads. Subagent children
 * stay off the keys, but one waiting on the user lights its parent.
 */
export function candidateThreads(
  environments: ReadonlyArray<CandidateSource>,
  now: string,
  options: CandidateOptions = {},
): ScopedThread[] {
  const result: ScopedThread[] = [];
  for (const { environmentId, threads, projects, scratchWorkspaceRoot } of environments) {
    const scope = options.scope ?? null;
    const inScope =
      scope === null
        ? null
        : new Set(
            [...(projects ?? [])]
              .filter((project) =>
                projectScopeKeys(environmentId, project, scratchWorkspaceRoot ?? null).has(scope),
              )
              .map((project) => project.id),
          );
    const all = [...threads];
    const parentsWaiting = new Set<string>();
    for (const thread of all) {
      const parent = thread.lineage.parentThreadId;
      if (
        parent &&
        thread.lineage.relationshipToParent === "subagent" &&
        !thread.archivedAt &&
        !thread.deletedAt &&
        thread.pendingRuntimeRequest !== null
      ) {
        parentsWaiting.add(parent);
      }
    }
    for (const thread of all) {
      if (thread.deletedAt || thread.archivedAt) continue;
      if (thread.lineage.relationshipToParent === "subagent") continue;
      if (thread.snoozedUntil && thread.snoozedUntil > now) continue;
      if (inScope && !inScope.has(thread.projectId)) continue;
      if (options.hideSettled && thread.settledAt !== null) {
        const status = threadStatus(thread, parentsWaiting.has(thread.id));
        if (status !== "working" && status !== "needs-input") continue;
      }
      result.push({
        environmentId,
        threadId: thread.id,
        thread,
        childNeedsInput: parentsWaiting.has(thread.id),
      });
    }
  }
  return result;
}

export type AgentSource = "recent" | "priority" | "pinned";

const PRIORITY: Record<SlotStatus, number> = {
  "needs-input": 0,
  error: 1,
  working: 2,
  done: 3,
  idle: 4,
  off: 5,
};

function rank(threads: ReadonlyArray<ScopedThread>, source: AgentSource): ScopedThread[] {
  const byUpdate = (a: ScopedThread, b: ScopedThread) =>
    b.thread.updatedAt.localeCompare(a.thread.updatedAt);
  switch (source) {
    case "pinned":
      return threads
        .filter(({ thread }) => thread.pinnedAt)
        .toSorted(
          (a, b) =>
            (a.thread.pinOrderKey ?? "").localeCompare(b.thread.pinOrderKey ?? "") ||
            (a.thread.pinnedAt ?? "").localeCompare(b.thread.pinnedAt ?? ""),
        );
    case "recent":
      // Codex's default: the most recently updated threads.
      return threads.toSorted(byUpdate);
    case "priority":
      return threads
        .map((entry) => ({ entry, status: threadStatus(entry.thread, entry.childNeedsInput) }))
        .filter(
          ({ entry, status }) =>
            status === "working" ||
            status === "needs-input" ||
            !!entry.thread.pinnedAt ||
            entry.thread.settledAt === null,
        )
        .toSorted(
          (a, b) =>
            PRIORITY[a.status] - PRIORITY[b.status] ||
            Number(!!b.entry.thread.pinnedAt) - Number(!!a.entry.thread.pinnedAt) ||
            byUpdate(a.entry, b.entry),
        )
        .map(({ entry }) => entry);
  }
}

/**
 * Picks the threads for the six agent keys. A thread keeps its key while it
 * stays in the top six, so lights don't jump around; freed keys go to the
 * next thread in line. `pins` hard-assigns keys (`environmentId/threadId`).
 */
export function assignSlots(input: {
  readonly threads: ReadonlyArray<ScopedThread>;
  readonly previous: ReadonlyArray<Slot>;
  readonly source: AgentSource;
  readonly pins: ReadonlyArray<string | null>;
}): Slot[] {
  const byKey = new Map(input.threads.map((entry) => [refKey(entry), entry]));
  const pinned = new Set<string>();
  const ids: (string | null)[] = Array.from({ length: SLOT_COUNT }, (_, index) => {
    const key = input.pins[index] ?? null;
    if (key === null || !byKey.has(key) || pinned.has(key)) return null;
    pinned.add(key);
    return key;
  });
  const ranked = rank(input.threads, input.source).filter((entry) => !pinned.has(refKey(entry)));
  const chosen = new Set(ranked.slice(0, SLOT_COUNT - pinned.size).map(refKey));
  for (const slot of input.previous) {
    if (!slot.ref) continue;
    const key = refKey(slot.ref);
    if (ids[slot.index] === null && chosen.has(key)) {
      ids[slot.index] = key;
      chosen.delete(key);
    }
  }
  const rest = ranked.filter((entry) => chosen.has(refKey(entry)));
  for (let index = 0; index < SLOT_COUNT && rest.length > 0; index += 1) {
    if (ids[index] === null) ids[index] = refKey(rest.shift()!);
  }
  return ids.map((key, index) => {
    const entry = key === null ? undefined : byKey.get(key);
    return entry
      ? {
          index,
          ref: { environmentId: entry.environmentId, threadId: entry.threadId },
          title: entry.thread.title,
          status: threadStatus(entry.thread, entry.childNeedsInput),
        }
      : EMPTY_SLOTS[index]!;
  });
}
