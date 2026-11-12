import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

import { readAllowance, rateLimitedUntil } from "../src/accounts/allowance";
import { AccountManager } from "../src/accounts/manager";
import { proxyWithRetry } from "../src/utils/http";

// Headers exactly as Anthropic sent them for two subscription accounts, one
// with allowance left (200) and one whose week is spent (429).
const NOW = 1794482000_000;
const SERVING = new Headers({
  "anthropic-ratelimit-unified-5h-reset": "1794498000",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.02",
  "anthropic-ratelimit-unified-7d-reset": "1794744000",
  "anthropic-ratelimit-unified-7d-status": "allowed_warning",
  "anthropic-ratelimit-unified-7d-surpassed-threshold": "0.75",
  "anthropic-ratelimit-unified-7d-utilization": "0.82",
  "anthropic-ratelimit-unified-overage-status": "allowed",
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-reset": "1794744000",
  "anthropic-ratelimit-unified-status": "allowed_warning",
});
const SPENT = new Headers({
  "anthropic-ratelimit-unified-5h-reset": "1794499800",
  "anthropic-ratelimit-unified-5h-status": "allowed",
  "anthropic-ratelimit-unified-5h-utilization": "0.0",
  "anthropic-ratelimit-unified-7d-reset": "1794513600",
  "anthropic-ratelimit-unified-7d-status": "rejected",
  "anthropic-ratelimit-unified-7d-utilization": "1.0",
  "anthropic-ratelimit-unified-overage-disabled-reason":
    "org_spend_cap_reached",
  "anthropic-ratelimit-unified-overage-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "seven_day",
  "anthropic-ratelimit-unified-reset": "1794513600",
  "anthropic-ratelimit-unified-status": "rejected",
  "retry-after": "31413",
});

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Allowance headers for an account, relative to the real clock. */
function allowanceHeaders(opts: {
  weekRefillsIn: number;
  weekStatus?: string;
  status?: string;
}): Headers {
  const refill = Math.round((Date.now() + opts.weekRefillsIn) / 1000);
  return new Headers({
    "anthropic-ratelimit-unified-7d-reset": String(refill),
    "anthropic-ratelimit-unified-7d-status": opts.weekStatus ?? "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-status": opts.status ?? "allowed",
    "anthropic-ratelimit-unified-reset": String(refill),
  });
}

function withManager(
  emails: string[],
  fn: (manager: AccountManager) => Promise<void> | void,
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-allowance-"));
  const manager = new AccountManager(dir, {
    provider: "anthropic",
    refresh: async () => ({}) as any,
  });
  for (const email of emails) {
    manager.addAccount({
      accessToken: `token-${email}`,
      refreshToken: "r",
      email,
      expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
      accountUuid: "",
      provider: "anthropic",
    });
  }
  return Promise.resolve(fn(manager)).finally(() =>
    fs.rmSync(dir, { recursive: true, force: true }),
  );
}

const pick = (manager: AccountManager) => {
  const result = manager.getNextAccount();
  assert.ok(result.account, "an account is available");
  return result.account.token.email;
};
const snapshot = (manager: AccountManager, email: string) =>
  manager.getSnapshots().find((s) => s.email === email)!;

// ══════════════════════════════════════════════════
// Reading what Anthropic says
// ══════════════════════════════════════════════════

test("reads an account's allowance from Anthropic's response headers", () => {
  const allowance = readAllowance(SERVING, NOW)!;
  assert.equal(allowance.status, "allowed_warning");
  assert.equal(allowance.overage, "allowed");
  assert.equal(allowance.resetsAt, 1794744000_000);
  assert.deepEqual(allowance.windows["7d"], {
    utilization: 0.82,
    resetsAt: 1794744000_000,
    status: "allowed_warning",
  });
  assert.deepEqual(allowance.windows["5h"], {
    utilization: 0.02,
    resetsAt: 1794498000_000,
    status: "allowed",
  });
  assert.equal(allowance.observedAt, NOW);
});

test("a response without allowance headers says nothing (Codex, Cursor, count_tokens)", () => {
  assert.equal(
    readAllowance(new Headers({ "content-type": "application/json" })),
    null,
  );
  assert.equal(readAllowance(new Headers({ "retry-after": "30" })), null);
});

test("a spent allowance's 429 names its refill time, not the retry-after rounding", () => {
  assert.equal(rateLimitedUntil(SPENT, NOW), 1794513600_000);
});

test("any other 429 is taken at its Retry-After word", () => {
  assert.equal(
    rateLimitedUntil(new Headers({ "retry-after": "30" }), NOW),
    NOW + 30_000,
  );
});

test("a 429 that says nothing usable leaves the cooldown to the backoff", () => {
  assert.equal(rateLimitedUntil(new Headers(), NOW), undefined);
  // An HTTP-date Retry-After, a zero, or a refill time already past.
  assert.equal(
    rateLimitedUntil(
      new Headers({ "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }),
      NOW,
    ),
    undefined,
  );
  assert.equal(
    rateLimitedUntil(new Headers({ "retry-after": "0" }), NOW),
    undefined,
  );
  const stale = new Headers(SPENT);
  stale.delete("retry-after");
  assert.equal(rateLimitedUntil(stale, 1794513600_000 + 1), undefined);
});

// ══════════════════════════════════════════════════
// Benching a spent account
// ══════════════════════════════════════════════════

test("an account whose allowance is spent stays out until it refills", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    const refill = Date.now() + 2 * HOUR;
    manager.recordFailure("b@x.test", "rate_limit", undefined, refill);
    assert.ok(
      Math.abs(snapshot(manager, "b@x.test").cooldownUntil - refill) < 1000,
    );
    for (let i = 0; i < 5; i++) assert.equal(pick(manager), "a@x.test");
  }));

test("a refill days away is re-checked after six hours at most, in case the limit lifts early", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    const before = Date.now();
    manager.recordFailure(
      "b@x.test",
      "rate_limit",
      undefined,
      before + 3 * DAY,
    );
    const until = snapshot(manager, "b@x.test").cooldownUntil;
    assert.ok(until >= before + 6 * HOUR && until <= Date.now() + 6 * HOUR);
  }));

test("a 429 without a refill time keeps the old one-minute backoff", () =>
  withManager(["a@x.test"], (manager) => {
    const before = Date.now();
    manager.recordFailure("a@x.test", "rate_limit");
    const until = snapshot(manager, "a@x.test").cooldownUntil;
    assert.ok(until >= before + 60_000 && until <= Date.now() + 60_000);
  }));

// ══════════════════════════════════════════════════
// Choosing an account
// ══════════════════════════════════════════════════

test("spends the allowance that refills soonest first, keeping the other in reserve", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 6 * DAY }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 2 * DAY }),
    );
    for (let i = 0; i < 5; i++) assert.equal(pick(manager), "b@x.test");
  }));

test("switches as soon as another account refills sooner, even mid-stick", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    assert.equal(pick(manager), "a@x.test");
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 6 * DAY }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY }),
    );
    assert.equal(pick(manager), "b@x.test");
  }));

test("asks an account it has not heard from yet before choosing between them", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    assert.equal(pick(manager), "a@x.test");
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY }),
    );
    // b has said nothing: one request to b, then the choice works from facts.
    assert.equal(pick(manager), "b@x.test");
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 5 * DAY }),
    );
    assert.equal(pick(manager), "a@x.test");
  }));

test("a week that has ended is forgotten, so the account is asked afresh", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 2 * DAY }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: -1000 }),
    );
    assert.equal(pick(manager), "b@x.test");
  }));

test("plan allowance comes before paid extra usage", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    // a's week is spent but it still serves, on extra usage; b has plan left.
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY, weekStatus: "rejected" }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 6 * DAY }),
    );
    for (let i = 0; i < 3; i++) assert.equal(pick(manager), "b@x.test");
  }));

test("extra usage still serves when no account has plan allowance left", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY, weekStatus: "rejected" }),
    );
    manager.recordFailure(
      "b@x.test",
      "rate_limit",
      undefined,
      Date.now() + HOUR,
    );
    assert.equal(pick(manager), "a@x.test");
  }));

test("accounts that report no allowance stay sticky and skip a cooled-down one, as before", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    const first = pick(manager);
    for (let i = 0; i < 5; i++) assert.equal(pick(manager), first);
    manager.recordFailure(first, "rate_limit");
    const other = first === "a@x.test" ? "b@x.test" : "a@x.test";
    assert.equal(pick(manager), other);
  }));

test("a replaced token forgets the old one's allowance", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 2 * DAY }),
    );
    manager.addAccount({
      accessToken: "a-new-token",
      refreshToken: "r",
      email: "a@x.test",
      expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
      accountUuid: "",
      provider: "anthropic",
    });
    assert.equal(snapshot(manager, "a@x.test").allowance, null);
  }));

test("the admin snapshot shows what Anthropic last said about each account", () =>
  withManager(["a@x.test"], (manager) => {
    manager.recordAllowance("a@x.test", SERVING);
    const allowance = snapshot(manager, "a@x.test").allowance!;
    assert.equal(allowance.windows["7d"].utilization, 0.82);
    assert.equal(allowance.status, "allowed_warning");
  }));

// ══════════════════════════════════════════════════
// End to end through proxyWithRetry
// ══════════════════════════════════════════════════

function mockResponse(): any {
  const resp: any = new EventEmitter();
  resp.locals = {};
  resp.headers = {};
  resp.headersSent = false;
  resp.destroyed = false;
  resp.writableEnded = false;
  resp.setHeader = (k: string, v: string) => {
    resp.headers[k.toLowerCase()] = v;
    return resp;
  };
  resp.status = (code: number) => {
    resp.statusCode = code;
    return resp;
  };
  resp.json = (body: any) => {
    resp.body = body;
    resp.writableEnded = true;
    return resp;
  };
  return resp;
}

test("a spent account's 429 is served by the other account, and the spent one sits out until it refills", () =>
  withManager(["a@x.test", "b@x.test"], async (manager) => {
    const refill = Math.round((Date.now() + 3 * HOUR) / 1000);
    const spent = new Headers({
      "anthropic-ratelimit-unified-7d-reset": String(refill),
      "anthropic-ratelimit-unified-7d-status": "rejected",
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String(refill),
      "retry-after": "10800",
    });
    const served: string[] = [];
    const resp = mockResponse();
    await proxyWithRetry("Test", resp, { debug: "off" } as any, {
      manager,
      upstream: async (account) =>
        account.token.email === "a@x.test"
          ? new Response("{}", { status: 429, headers: spent })
          : new Response("{}", {
              status: 200,
              headers: allowanceHeaders({ weekRefillsIn: 4 * DAY }),
            }),
      success: async (_upstream, account) => {
        served.push(account.token.email);
      },
    });
    assert.deepEqual(served, ["b@x.test"]);
    const a = snapshot(manager, "a@x.test");
    assert.ok(Math.abs(a.cooldownUntil - refill * 1000) < 1000);
    assert.equal(a.allowance!.status, "rejected");
    assert.equal(
      snapshot(manager, "b@x.test").allowance!.windows["7d"].status,
      "allowed",
    );
    // Later requests go straight to b, without trying a first.
    assert.equal(pick(manager), "b@x.test");
  }));
