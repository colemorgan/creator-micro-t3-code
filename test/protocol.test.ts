import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decodeReport,
  encodeRpcRequest,
  findEndpoints,
  LineAssembler,
  parseRpcLine,
  reconcileEndpoint,
} from "../src/device/protocol.ts";

const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

test("encodes a request as 64-byte vendor reports with CRLF", () => {
  const params = { long: "x".repeat(100) };
  const reports = encodeRpcRequest("v.oai.rgbcfg", params, 42);
  assert.ok(reports.length > 1);
  let payload = "";
  for (const report of reports) {
    assert.equal(report.length, 64);
    assert.equal(report[0], 6);
    assert.equal(report[1], 2);
    payload += text(report.subarray(3, 3 + report[2]!));
  }
  assert.equal(payload, `${JSON.stringify({ method: "v.oai.rgbcfg", params, id: 42 })}\r\n`);
});

test("alternate framings drop the report id or the line ending", () => {
  const [bare] = encodeRpcRequest("device.status", null, 1, { report: "prefixed", crlf: false });
  assert.ok(!text(bare!.subarray(3, 3 + bare![2]!)).endsWith("\n"));
  const [unprefixed] = encodeRpcRequest("device.status", null, 1, { report: "unprefixed", crlf: true });
  assert.equal(unprefixed![0], 0);
});

test("escapes non-ASCII for the firmware's parser", () => {
  const [report] = encodeRpcRequest("x", { title: "café" }, 1);
  assert.match(text(report!.subarray(3, 3 + report![2]!)), /caf\\u00e9/);
});

test("decodes reports with or without the report id", () => {
  const body = new TextEncoder().encode('{"m":"v.oai.hid"}\n');
  const withId = new Uint8Array(64);
  withId.set([6, 2, body.length]);
  withId.set(body, 3);
  assert.deepEqual(decodeReport(withId), { channel: 2, text: '{"m":"v.oai.hid"}\n' });
  assert.deepEqual(decodeReport(withId.subarray(1)), { channel: 2, text: '{"m":"v.oai.hid"}\n' });
  const keyboard = new Uint8Array(64);
  keyboard[0] = 1;
  assert.equal(decodeReport(keyboard), null);
});

test("reassembles lines split across reports and parses abbreviated RPC", () => {
  const lines = new LineAssembler();
  assert.deepEqual(lines.push({ channel: 2, text: '{"m":"v.oai.hid","p":{"k":"AG0' }), []);
  const [line] = lines.push({ channel: 2, text: '0","act":1}}\r\n' });
  assert.deepEqual(parseRpcLine(line!), {
    kind: "notification",
    method: "v.oai.hid",
    params: { k: "AG00", act: 1 },
  });
  assert.deepEqual(parseRpcLine('{"i":7,"result":{"version":"0.4.1"}}'), {
    kind: "response",
    id: "7",
    result: { version: "0.4.1" },
    error: null,
  });
  assert.equal(parseRpcLine('{"id":3,"error":{"message":"Method not found"}}')?.kind, "response");
  assert.equal(parseRpcLine("garbage"), null);
});

test("finds the vendor collection, preferring USB", () => {
  const base = { vendorId: 0x303a, productId: 0x8360 };
  const endpoints = findEndpoints([
    { ...base, path: "bt", usagePage: 0xff00, release: 0x0101 },
    { ...base, path: "usb-kbd", usagePage: 0x01, release: 0x0100 },
    { ...base, path: "usb", usagePage: 0xff00, release: 0x0100 },
    { vendorId: 0x046d, productId: 1, path: "mouse", usagePage: 0xff00, release: 0 },
  ]);
  assert.deepEqual(endpoints, [
    { path: "usb", transport: "usb" },
    { path: "bt", transport: "bluetooth" },
  ]);
  // Without usage pages (some hidraw setups) every matching path is a candidate.
  assert.deepEqual(findEndpoints([{ ...base, path: "/dev/hidraw4", release: 0x100 }]), [
    { path: "/dev/hidraw4", transport: "usb" },
  ]);
});

test("moves to USB when a cable appears and keeps a live endpoint otherwise", () => {
  const bt = { path: "bt", transport: "bluetooth" } as const;
  const usb = { path: "usb", transport: "usb" } as const;
  assert.deepEqual(reconcileEndpoint(bt, [bt]), { keep: true });
  assert.deepEqual(reconcileEndpoint(bt, [usb, bt]), { keep: false, next: usb });
  assert.deepEqual(reconcileEndpoint(usb, []), { keep: false, next: null });
});
