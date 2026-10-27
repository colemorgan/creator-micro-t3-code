// The subset of T3 Code's wire types the bridge reads. Field names follow
// `OrchestrationV2ThreadShell` in packages/contracts/src/orchestrationV2.ts.

export type RunStatus =
  | "idle"
  | "preparing"
  | "queued"
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "interrupted"
  | "failed"
  | "cancelled"
  | "rolled_back";

export interface ModelSelection {
  readonly instanceId: string;
  readonly model: string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>;
}

export interface ThreadShell {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly creationSource?: string;
  readonly providerInstanceId: string;
  readonly modelSelection: ModelSelection;
  readonly interactionMode: string;
  readonly lineage: {
    readonly parentThreadId: string | null;
    readonly relationshipToParent: "fork" | "subagent" | null;
  };
  readonly latestRunId: string | null;
  readonly latestRunCompletedAt?: string | null;
  readonly activeRunId: string | null;
  readonly activeProviderThreadId: string | null;
  readonly activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null;
  readonly blockedOnThreadWait?: boolean;
  readonly status: RunStatus;
  readonly lastErrorClass?: string | null;
  readonly pendingRuntimeRequest: {
    readonly id: string;
    readonly kind: string;
    readonly blocking?: boolean;
  } | null;
  readonly pendingGuestMessageCount?: number;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly settledAt: string | null;
  readonly snoozedUntil?: string | null;
  readonly pinnedAt?: string | null;
  readonly pinOrderKey?: string | null;
  readonly lastVisitedAt?: string | null;
}

export interface ProjectShell {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly repositoryIdentity?: {
    readonly canonicalKey: string;
    readonly rootPath?: string | null;
    readonly origin?: { readonly canonicalKey?: string } | null;
  } | null;
}

export interface Shortcut {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  /** Command on macOS, Ctrl elsewhere. */
  readonly modKey: boolean;
}

export interface Keybinding {
  readonly command: string;
  readonly shortcut: Shortcut;
}

export interface OptionDescriptor {
  readonly id: string;
  readonly label?: string;
  readonly type: "select" | "boolean" | string;
  readonly options?: ReadonlyArray<{ readonly id: string; readonly label?: string; readonly isDefault?: boolean }>;
  readonly currentValue?: string | boolean;
}

export interface ProviderInfo {
  readonly instanceId: string;
  readonly models: ReadonlyArray<{
    readonly slug?: string;
    readonly id?: string;
    readonly capabilities?: { readonly optionDescriptors?: ReadonlyArray<OptionDescriptor> };
  }>;
}
