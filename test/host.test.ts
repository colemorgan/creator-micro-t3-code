import assert from "node:assert/strict";
import { test } from "node:test";

import { MacHost } from "../src/host/host.ts";
import { silentLogger } from "../src/log.ts";

test("key events run strictly in order, even when an earlier one is slow", async () => {
  const host = new MacHost({ appName: "T3 Code (Beta)", scheme: "t3code", log: silentLogger });
  const order: string[] = [];
  const slow = (name: string, ms: number) => () =>
    new Promise<void>((resolve) => setTimeout(() => (order.push(name), resolve()), ms));
  const inOrder = (host as any).inOrder.bind(host);
  await Promise.all([inOrder(slow("down", 50)), inOrder(slow("up", 0))]);
  assert.deepEqual(order, ["down", "up"]);
  // A failure doesn't stall the queue.
  await assert.rejects(inOrder(() => Promise.reject(new Error("x"))));
  await inOrder(slow("after", 0));
  assert.deepEqual(order, ["down", "up", "after"]);
});
