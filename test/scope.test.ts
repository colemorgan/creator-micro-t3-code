import assert from "node:assert/strict";
import { test } from "node:test";

import { lastScopeKey } from "../src/host/sidebarScope.ts";
import { projectScopeKeys, SCRATCH_SCOPE_KEY } from "../src/model/scope.ts";
import { candidateThreads } from "../src/model/slots.ts";
import { thread } from "./fixtures.ts";

const state = (scope: string | null) =>
  JSON.stringify({ projectOrder: [], sidebarProjectScopeKey: scope, threadLastVisitedAtById: {} });

test("reads the newest sidebar filter from localStorage bytes, in either encoding", () => {
  const latin1 = Buffer.from(`\x01junk${state(null)}\x00\x01${state("github.com/a/b")}`, "latin1");
  assert.equal(lastScopeKey(latin1), "github.com/a/b");
  const cleared = Buffer.concat([latin1, Buffer.from(`\x01${state(null)}`, "latin1")]);
  assert.equal(lastScopeKey(cleared), null);
  const utf16 = Buffer.concat([latin1, Buffer.from(`\x00${state("env:/Users/me/ünïcode")}`, "utf16le")]);
  assert.equal(lastScopeKey(utf16), "env:/Users/me/ünïcode");
  assert.equal(lastScopeKey(Buffer.from(state(SCRATCH_SCOPE_KEY), "latin1")), SCRATCH_SCOPE_KEY);
  assert.equal(lastScopeKey(Buffer.from("nothing here")), undefined);
});

test("a project matches every key the sidebar could use for it", () => {
  const project = {
    id: "p1",
    title: "Acme",
    workspaceRoot: "/home/dev/acme-app/app/",
    repositoryIdentity: { canonicalKey: "github.com/example/acme-app", rootPath: "/home/dev/acme-app" },
  };
  assert.deepEqual(
    [...projectScopeKeys("env", project, null)].sort(),
    [
      "env:/home/dev/acme-app/app",
      "env:p1",
      "github.com/example/acme-app",
      "github.com/example/acme-app::app",
    ],
  );
  const scratch = { id: "s", title: "No project", workspaceRoot: "/home/dev/.t3/scratch" };
  assert.ok(projectScopeKeys("env", scratch, "/home/dev/.t3/scratch").has(SCRATCH_SCOPE_KEY));
});

test("a filtered sidebar keeps that project's unsettled or active threads, across servers", () => {
  const repo = { canonicalKey: "github.com/example/acme-app", rootPath: "/x" };
  const sources = [
    {
      environmentId: "mac",
      projects: [{ id: "p", title: "Acme", workspaceRoot: "/x", repositoryIdentity: repo }],
      threads: [
        thread({ id: "open", projectId: "p" }),
        thread({ id: "settled", projectId: "p", settledAt: "2026-10-27T09:00:00Z" }),
        thread({ id: "settled-but-running", projectId: "p", settledAt: "2026-10-27T09:00:00Z", status: "running" }),
        thread({ id: "other-project", projectId: "q" }),
      ],
    },
    {
      environmentId: "server",
      projects: [{ id: "p2", title: "Acme", workspaceRoot: "/srv/x", repositoryIdentity: repo }],
      threads: [thread({ id: "remote", projectId: "p2" })],
    },
  ];
  const ids = (options: Parameters<typeof candidateThreads>[2]) =>
    candidateThreads(sources, "2026-10-27T12:00:00Z", options).map((entry) => entry.threadId);
  assert.deepEqual(ids({ scope: "github.com/example/acme-app", hideSettled: true }), [
    "open",
    "settled-but-running",
    "remote",
  ]);
  assert.deepEqual(ids({ scope: null, hideSettled: true }), ["open", "settled-but-running", "other-project", "remote"]);
  assert.equal(ids({}).length, 5);
});
