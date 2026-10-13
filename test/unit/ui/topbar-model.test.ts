// topbar-model (ADR-036, SPEC.md section 6): Approve in the top bar reads the
// daemon's progress (`tier1`), never computes the gate; what the bar draws for
// each review state, confirm step, request in flight and refusal; and the
// ApprovalPort's routes, refusals and ordering against the route's refetches.

import { describe, expect, it } from "vitest";
import type { ChangeSummary } from "../../../src/core/model/types.js";
import { createApi } from "../../../src/ui/data/api.js";
import { createApprovalPort } from "../../../src/ui/data/approval-port.js";
import {
  APPROVE,
  APPROVE_WAITING,
  approveGate,
  approveView,
  CHECK_REST,
  CHECK_REST_MOVED,
  checkRestView,
  isStaleList,
  NO_REVIEW_STATE,
} from "../../../src/ui/screens/change/model/approve.js";
import type { ApprovalStatus } from "../../../src/ui/screens/change/ports.js";

const HEAD = "3f2a9c41d0b7e6a5c4d3e2f1a0b9c8d7e6f5a4b3";
const status = (over: Partial<ApprovalStatus> = {}): ApprovalStatus => ({
  reviewState: "in-review",
  head: HEAD,
  approvedHead: null,
  approvedAt: null,
  ...over,
});
const tier1 = (done: number, total: number) => ({ tier1: { done, total } });
const base = {
  status: status(),
  progress: tier1(2, 2),
  confirming: false,
  pending: null,
  error: null,
} as const;

describe("topbar-model", () => {
  it("approve-gate-from-progress: open only when progress.tier1 is complete, total 0 included", () => {
    expect(approveGate(tier1(0, 2))).toEqual({
      open: false,
      reason: "0 of 2 touched tier 1 files have a current review mark",
    });
    expect(approveGate(tier1(1, 2)).open).toBe(false);
    expect(approveGate(tier1(2, 2))).toEqual({
      open: true,
      reason: "All 2 touched tier 1 files have a current review mark",
    });
    expect(approveGate(tier1(1, 1)).reason).toBe(
      "All 1 touched tier 1 file has a current review mark",
    );
    // No tier 1 file touched: nothing stands in the way, as on the server.
    expect(approveGate(tier1(0, 0))).toEqual({
      open: true,
      reason: "No tier 1 file is touched in this change",
    });
    // No review state (not loaded, no snapshot): closed.
    expect(approveGate(null)).toEqual({ open: false, reason: NO_REVIEW_STATE });
    // Only `tier1` decides: the attention counter and allAttentionDone are not read.
    expect(
      approveGate({
        ...tier1(1, 1),
        attention: { done: 0, total: 3 },
        allAttentionDone: false,
      } as never).open,
    ).toBe(true);
  });

  it("approve-view: hidden, gate, confirm, in flight, approved, refusal", () => {
    expect(approveView({ ...base, status: null })).toEqual({ kind: "hidden" });
    expect(approveView({ ...base, progress: tier1(0, 1) })).toMatchObject({
      kind: "gate",
      open: false,
      label: APPROVE_WAITING,
    });
    expect(approveView(base)).toMatchObject({
      kind: "gate",
      open: true,
      label: APPROVE,
      error: null,
    });
    // Confirming is only possible while the gate is open.
    expect(approveView({ ...base, confirming: true })).toMatchObject({
      kind: "confirm",
      prompt: "Approve 3f2a9c4?",
      pending: false,
    });
    expect(
      approveView({ ...base, confirming: true, progress: tier1(0, 1) }),
    ).toMatchObject({ kind: "gate", open: false });
    expect(
      approveView({ ...base, confirming: true, pending: "approve" }),
    ).toMatchObject({ kind: "confirm", pending: true });
    const approved = status({
      reviewState: "approved",
      approvedHead: HEAD,
      approvedAt: "2026-05-04T11:19:00.000Z",
    });
    expect(approveView({ ...base, status: approved })).toMatchObject({
      kind: "approved",
      head: "3f2a9c4",
      pending: false,
      title: expect.stringContaining(HEAD) as string,
    });
    // Approved stays approved whatever the marks say now; undo in flight.
    expect(
      approveView({
        ...base,
        status: approved,
        progress: tier1(0, 1),
        pending: "undo",
      }),
    ).toMatchObject({ kind: "approved", pending: true });
    // A refusal: back to the gate, with the reason.
    expect(
      approveView({
        ...base,
        error: "1 touched tier 1 file(s) have no current review mark",
      }),
    ).toMatchObject({
      kind: "gate",
      open: true,
      error: "1 touched tier 1 file(s) have no current review mark",
    });
    // The head moved and the daemon reset the state: the gate again.
    expect(
      approveView({
        ...base,
        status: status({
          reviewState: "unreviewed",
          head: "c0ffee0000000000000000000000000000000000",
        }),
        progress: tier1(0, 1),
      }),
    ).toMatchObject({
      kind: "gate",
      open: false,
    });
  });

  it("check-rest: offered only while tier 1 files are unmarked, with a review state and nothing in flight", () => {
    // Without the option (the default), the gate waits as before.
    expect(approveView({ ...base, progress: tier1(1, 2) })).toMatchObject({ kind: "gate", open: false, bulk: false, label: APPROVE_WAITING });
    expect(approveView({ ...base, progress: tier1(1, 2), checkRest: true })).toMatchObject({
      kind: "gate",
      open: true,
      bulk: true,
      label: CHECK_REST,
      title: expect.stringContaining("1 of 2 touched tier 1 files have a current review mark") as string,
    });
    // Everything marked: plain Approve, unchanged.
    expect(approveView({ ...base, checkRest: true })).toMatchObject({ kind: "gate", open: true, bulk: false, label: APPROVE });
    // No review state: nothing to check against, closed.
    expect(approveView({ ...base, progress: null, checkRest: true })).toMatchObject({ kind: "gate", open: false, bulk: false, title: NO_REVIEW_STATE });
    // Approved: the badge, whatever is left.
    expect(approveView({ ...base, status: status({ reviewState: "approved", approvedHead: HEAD }), progress: tier1(0, 2), checkRest: true })).toMatchObject({ kind: "approved" });
    // A refusal keeps its reason on the offer.
    expect(approveView({ ...base, progress: tier1(0, 2), checkRest: true, error: "no" })).toMatchObject({ bulk: true, error: "no" });
  });

  it("check-rest-view: lists the daemon's files, says what confirming does, and the stale-list refusals", () => {
    expect(checkRestView({ head: HEAD, files: ["src/a.ts", "src/b.ts"] })).toEqual({
      title: CHECK_REST,
      lede: "2 touched tier 1 files have no current mark. Confirming marks them Checked and approves the change at 3f2a9c4.",
      files: ["src/a.ts", "src/b.ts"],
      confirm: "Check 2 files and approve",
    });
    expect(checkRestView({ head: HEAD, files: ["src/a.ts"] })).toMatchObject({
      lede: "1 touched tier 1 file has no current mark. Confirming marks it Checked and approves the change at 3f2a9c4.",
      confirm: "Check 1 file and approve",
    });
    expect(checkRestView({ head: HEAD, files: [] })).toMatchObject({ files: [], confirm: "Approve 3f2a9c4" });
    expect(isStaleList("snapshot-moved")).toBe(true);
    expect(isStaleList("remaining-changed")).toBe(true);
    expect(isStaleList("tier1-unchecked")).toBe(false);
    expect(isStaleList("snapshot-pending")).toBe(false);
    expect(CHECK_REST_MOVED).toMatch(/look again/);
  });

  it("approval-port: POST and DELETE the approve route, refusals with their message, stale summaries ignored", async () => {
    const seen: { url: string; method: string | undefined }[] = [];
    let next: Response = new Response(
      JSON.stringify({
        reviewState: "approved",
        approvedHead: HEAD,
        approvedAt: "2026-05-04T11:19:00.000Z",
      }),
      { status: 200 },
    );
    const api = createApi("", (input, init) => {
      seen.push({
        url:
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        method: init?.method,
      });
      return Promise.resolve(next);
    });
    let written = 0;
    const port = createApprovalPort(api, 11, () => {
      written += 1;
    });
    let changes = 0;
    port.onChange(() => {
      changes += 1;
    });
    expect(port.status()).toBeNull();
    const change = {
      reviewState: "in-review",
      head: HEAD,
      approvedHead: null,
      approvedAt: null,
      archivedAt: null,
    } as unknown as ChangeSummary;
    const before = performance.now();
    port.show(change, before);
    expect(port.status()).toEqual(status());

    const result = await port.approve();
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ url: "/api/changes/11/approve", method: "POST" }]);
    expect(port.status()).toMatchObject({
      reviewState: "approved",
      approvedHead: HEAD,
    });
    expect(written).toBe(1);
    expect(changes).toBe(2);
    // A summary fetched before the answer says what the write replaced: ignored.
    port.show(change, before);
    expect(port.status()?.reviewState).toBe("approved");
    // One fetched after it is the daemon's word (here: the head moved, reset).
    port.show(
      { ...change, reviewState: "unreviewed", head: "c0ffee" },
      performance.now(),
    );
    expect(port.status()).toMatchObject({
      reviewState: "unreviewed",
      head: "c0ffee",
    });

    next = new Response(
      JSON.stringify({
        error: { code: "not-approved", message: "change 11 is not approved" },
      }),
      { status: 409 },
    );
    const refused = await port.unapprove();
    expect(refused).toEqual({
      ok: false,
      refusal: { code: "not-approved", message: "change 11 is not approved" },
    });
    expect(seen[1]).toEqual({
      url: "/api/changes/11/approve",
      method: "DELETE",
    });
    expect(written).toBe(1);

    // An archived change has no button.
    port.show(
      { ...change, archivedAt: "2026-05-05T00:00:00.000Z" },
      performance.now(),
    );
    expect(port.status()).toBeNull();
  });

  it("approval-port: check the rest reads the list, then sends back exactly what it answered with checkRemaining", async () => {
    const remaining = { snapshotId: 7, head: HEAD, files: ["src/auth/guard.ts"], token: "f".repeat(64) };
    const seen: { url: string; method: string; body: unknown }[] = [];
    const answers: Response[] = [
      new Response(JSON.stringify(remaining), { status: 200 }),
      new Response(JSON.stringify({ error: { code: "snapshot-moved", message: "look again" } }), { status: 409 }),
      new Response(JSON.stringify({ reviewState: "approved", approvedHead: HEAD, approvedAt: "2026-05-04T11:19:00.000Z", marked: remaining.files }), { status: 200 }),
    ];
    const api = createApi("", (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      seen.push({ url, method: init?.method ?? "GET", body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null });
      const next = answers.shift();
      return next === undefined ? Promise.reject(new Error("no answer")) : Promise.resolve(next);
    });
    let written = 0;
    const port = createApprovalPort(api, 11, () => {
      written += 1;
    });
    port.show({ reviewState: "in-review", head: HEAD, approvedHead: null, approvedAt: null, archivedAt: null } as unknown as ChangeSummary, performance.now());

    const listed = await port.remaining();
    expect(listed).toMatchObject({ ok: true, value: remaining });
    expect(seen[0]).toEqual({ url: "/api/changes/11/approve/remaining", method: "GET", body: null });
    expect(written).toBe(0);

    // A stale list is a refusal like any other: the screen asks again.
    expect(await port.checkRest(remaining)).toEqual({ ok: false, refusal: { code: "snapshot-moved", message: "look again" } });
    expect(seen[1]).toEqual({ url: "/api/changes/11/approve", method: "POST", body: { checkRemaining: true, snapshotId: 7, files: remaining.files, token: remaining.token } });
    expect(port.status()?.reviewState).toBe("in-review");

    const done = await port.checkRest(remaining);
    expect(done).toMatchObject({ ok: true, value: { marked: ["src/auth/guard.ts"] } });
    expect(port.status()).toEqual(status({ reviewState: "approved", approvedHead: HEAD, approvedAt: "2026-05-04T11:19:00.000Z" }));
    expect(written).toBe(1);
  });
});
