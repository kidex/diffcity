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
});
