import test, { mock } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { EventEmitter } from "node:events";

import { readAllowance, rateLimitedUntil } from "../src/accounts/allowance";
import { AccountManager } from "../src/accounts/manager";
import { ProviderId } from "../src/auth/types";
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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Longer than the longest sticky stretch (60 min). */
const STRETCH = 61 * MINUTE;

/** Allowance headers for an account, relative to the (possibly fake) clock. */
function allowanceHeaders(opts: {
  weekRefillsIn: number;
  weekStatus?: string;
  status?: string;
  overage?: string;
  claim?: string;
}): Headers {
  const refill = Math.round((Date.now() + opts.weekRefillsIn) / 1000);
  return new Headers({
    "anthropic-ratelimit-unified-7d-reset": String(refill),
    "anthropic-ratelimit-unified-7d-status": opts.weekStatus ?? "allowed",
    "anthropic-ratelimit-unified-7d-utilization": "0.5",
    "anthropic-ratelimit-unified-status": opts.status ?? "allowed",
    "anthropic-ratelimit-unified-reset": String(refill),
    "anthropic-ratelimit-unified-overage-status": opts.overage ?? "rejected",
    "anthropic-ratelimit-unified-representative-claim":
      opts.claim ?? "seven_day",
  });
}

function makeManager(
  emails: string[],
  provider: ProviderId = "anthropic",
  refresh: (rt: string) => Promise<any> = async () => ({}),
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auth2api-allowance-"));
  const manager = new AccountManager(dir, { provider, refresh });
  for (const email of emails) {
    manager.addAccount({
      accessToken: `token-${email}`,
      refreshToken: "r",
      email,
      expiresAt: new Date(Date.now() + 365 * DAY).toISOString(),
      accountUuid: "",
      provider,
    });
  }
  return {
    manager,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

/** Runs fn with a manager, on a fake clock that `advance` moves. */
async function withManager(
  emails: string[],
  fn: (manager: AccountManager, advance: (ms: number) => void) => unknown,
  provider: ProviderId = "anthropic",
) {
  let now = Date.now();
  mock.timers.enable({ apis: ["Date"], now });
  const { manager, cleanup } = makeManager(emails, provider);
  try {
    await fn(manager, (ms) => mock.timers.setTime((now += ms)));
  } finally {
    mock.timers.reset();
    cleanup();
  }
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
  assert.equal(allowance.claim, "seven_day");
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

test("a spent week's 429 names the week's refill time", () => {
  assert.equal(rateLimitedUntil(SPENT, NOW), 1794513600_000);
});

test("a spent five-hour window's 429 names the five-hour refill", () => {
  const headers = new Headers(SPENT);
  headers.set("anthropic-ratelimit-unified-representative-claim", "five_hour");
  headers.set("anthropic-ratelimit-unified-reset", "1794499800");
  assert.equal(rateLimitedUntil(headers, NOW), 1794499800_000);
});

test("a single model's own cap does not take the whole account out", () => {
  // The account still serves other models: the ordinary backoff applies.
  const headers = new Headers(SPENT);
  headers.set(
    "anthropic-ratelimit-unified-representative-claim",
    "seven_day_opus",
  );
  assert.equal(rateLimitedUntil(headers, NOW), undefined);
});

test("a 429 while the account still serves on extra usage is taken at its Retry-After", () => {
  const headers = new Headers(SPENT);
  headers.set("anthropic-ratelimit-unified-overage-status", "allowed");
  headers.set("retry-after", "30");
  assert.equal(rateLimitedUntil(headers, NOW), NOW + 30_000);
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
});

test("a spent 429 whose refill time has already passed is taken at its Retry-After", () => {
  const headers = new Headers(SPENT);
  headers.set("anthropic-ratelimit-unified-reset", String(NOW / 1000 - 60));
  headers.set("retry-after", "120");
  assert.equal(rateLimitedUntil(headers, NOW), NOW + 120_000);
});

test("a spent 429 that does not name its limit benches only when the five-hour or weekly window says spent", () => {
  const named = new Headers(SPENT);
  named.delete("anthropic-ratelimit-unified-representative-claim");
  assert.equal(rateLimitedUntil(named, NOW), 1794513600_000);
  const unnamed = new Headers(named);
  unnamed.set("anthropic-ratelimit-unified-7d-status", "allowed");
  assert.equal(rateLimitedUntil(unnamed, NOW), undefined);
});

// ══════════════════════════════════════════════════
// Benching a spent account
// ══════════════════════════════════════════════════

test("an account whose allowance is spent stays out until it refills", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    const refill = Date.now() + 2 * HOUR;
    manager.recordFailure("b@x.test", "rate_limit", undefined, refill);
    assert.equal(snapshot(manager, "b@x.test").cooldownUntil, refill);
    for (let i = 0; i < 5; i++) assert.equal(pick(manager), "a@x.test");
  }));

test("a refill days away is re-checked after six hours, and only when nothing else can serve", () =>
  withManager(["a@x.test", "b@x.test"], (manager, advance) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({
        weekRefillsIn: 2 * DAY,
        weekStatus: "rejected",
        status: "rejected",
      }),
    );
    manager.recordFailure(
      "a@x.test",
      "rate_limit",
      undefined,
      Date.now() + 2 * DAY,
    );
    assert.equal(
      snapshot(manager, "a@x.test").cooldownUntil,
      Date.now() + 6 * HOUR,
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 5 * DAY }),
    );

    advance(6 * HOUR + 1);
    // a may be asked again, but b still has plan allowance: b serves.
    for (let i = 0; i < 3; i++) assert.equal(pick(manager), "b@x.test");
    // b falters: a is the one left, so it is asked.
    manager.recordFailure("b@x.test", "server");
    assert.equal(pick(manager), "a@x.test");
  }));

test("a later, shorter failure does not cut a spent account's bench short", () =>
  withManager(["a@x.test"], (manager) => {
    const refill = Date.now() + 2 * HOUR;
    manager.recordFailure("a@x.test", "rate_limit", undefined, refill);
    manager.recordFailure("a@x.test", "server");
    assert.equal(snapshot(manager, "a@x.test").cooldownUntil, refill);
  }));

test("a 429 without a refill time keeps the old one-minute backoff", () =>
  withManager(["a@x.test"], (manager) => {
    manager.recordFailure("a@x.test", "rate_limit");
    assert.equal(
      snapshot(manager, "a@x.test").cooldownUntil,
      Date.now() + MINUTE,
    );
  }));

test("a token refresh does not lift a spent account's bench", async () => {
  const { manager, cleanup } = makeManager(
    ["a@x.test"],
    "anthropic",
    async () => ({
      accessToken: "refreshed",
      refreshToken: "r2",
      email: "a@x.test",
      expiresAt: new Date(Date.now() + DAY).toISOString(),
      accountUuid: "",
    }),
  );
  try {
    const refill = Date.now() + 2 * HOUR;
    manager.recordFailure("a@x.test", "rate_limit", undefined, refill);
    assert.equal(await manager.refreshAccount("a@x.test"), true);
    assert.equal(snapshot(manager, "a@x.test").cooldownUntil, refill);
  } finally {
    cleanup();
  }
});

test("when every account is out, the answer names the soonest return, not the longest", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordFailure(
      "a@x.test",
      "rate_limit",
      undefined,
      Date.now() + 2 * DAY,
    );
    manager.recordFailure("b@x.test", "server");
    const result = manager.getNextAccount();
    assert.equal(result.account, null);
    if (result.account === null) {
      assert.equal(result.failureKind, "server");
      assert.equal(result.retryAfterMs, 5000);
    }
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

test("moves to the sooner refill when the sticky stretch ends, not in the middle of it", () =>
  withManager(["a@x.test", "b@x.test"], (manager, advance) => {
    assert.equal(pick(manager), "a@x.test");
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 6 * DAY }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY }),
    );
    assert.equal(pick(manager), "a@x.test", "prompt caches stay warm");
    advance(STRETCH);
    assert.equal(pick(manager), "b@x.test");
    advance(STRETCH);
    assert.equal(pick(manager), "b@x.test", "and stays on the best");
  }));

test("after a failure, traffic stays on the other account for its stretch", () =>
  withManager(["a@x.test", "b@x.test"], (manager, advance) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 5 * DAY }),
    );
    assert.equal(pick(manager), "a@x.test");
    manager.recordFailure("a@x.test", "server"); // out for 5 s
    assert.equal(pick(manager), "b@x.test");
    advance(10_000);
    assert.equal(
      pick(manager),
      "b@x.test",
      "no snapping back to a flaky account",
    );
    advance(STRETCH);
    assert.equal(pick(manager), "a@x.test");
  }));

test("asks an account it has not heard from yet, once, then chooses from facts", () =>
  withManager(["a@x.test", "b@x.test"], (manager, advance) => {
    assert.equal(pick(manager), "a@x.test");
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY }),
    );
    advance(STRETCH);
    // b has said nothing yet: one request to b...
    assert.equal(pick(manager), "b@x.test");
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 5 * DAY }),
    );
    // ...and straight back to a, whose week refills sooner.
    assert.equal(pick(manager), "a@x.test");
  }));

test("an account that never reports its allowance is asked once a stretch, not on every request", () =>
  withManager(["a@x.test", "x@x.test"], (manager, advance) => {
    assert.equal(pick(manager), "a@x.test");
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY }),
    );
    advance(STRETCH);
    assert.equal(pick(manager), "x@x.test", "asked");
    // x answers without allowance headers (a 401, or count_tokens): a serves.
    for (let i = 0; i < 5; i++) assert.equal(pick(manager), "a@x.test");
    advance(STRETCH);
    assert.equal(pick(manager), "x@x.test", "asked again a stretch later");
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
      allowanceHeaders({
        weekRefillsIn: 1 * DAY,
        weekStatus: "rejected",
        status: "rejected",
        overage: "allowed",
      }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 6 * DAY }),
    );
    for (let i = 0; i < 3; i++) assert.equal(pick(manager), "b@x.test");
  }));

test("an account that starts spending extra usage gives way at once, even mid-stretch", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({ weekRefillsIn: 1 * DAY }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 6 * DAY }),
    );
    assert.equal(pick(manager), "a@x.test");
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({
        weekRefillsIn: 1 * DAY,
        weekStatus: "rejected",
        status: "rejected",
        overage: "allowed",
      }),
    );
    assert.equal(pick(manager), "b@x.test");
  }));

test("extra usage on a limit not read on its own (one model's cap) still counts as extra usage", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({
        weekRefillsIn: 1 * DAY,
        status: "rejected",
        overage: "allowed",
        claim: "seven_day_opus",
      }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 6 * DAY }),
    );
    assert.equal(pick(manager), "b@x.test");
  }));

test("one model's cap, with no extra usage paid, leaves the account on plan for the other models", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({
        weekRefillsIn: 1 * DAY,
        status: "rejected",
        claim: "seven_day_opus",
      }),
    );
    manager.recordAllowance(
      "b@x.test",
      allowanceHeaders({ weekRefillsIn: 6 * DAY }),
    );
    // a's week refills sooner, and it still serves every other model.
    assert.equal(pick(manager), "a@x.test");
  }));

test("extra usage still serves when no account has plan allowance left", () =>
  withManager(["a@x.test", "b@x.test"], (manager) => {
    manager.recordAllowance(
      "a@x.test",
      allowanceHeaders({
        weekRefillsIn: 1 * DAY,
        weekStatus: "rejected",
        status: "rejected",
        overage: "allowed",
      }),
    );
    manager.recordFailure(
      "b@x.test",
      "rate_limit",
      undefined,
      Date.now() + HOUR,
    );
    assert.equal(pick(manager), "a@x.test");
  }));

test("a response without allowance headers leaves the last known allowance alone", () =>
  withManager(["a@x.test"], (manager) => {
    manager.recordAllowance("a@x.test", SERVING);
    manager.recordAllowance(
      "a@x.test",
      new Headers({ "content-type": "application/json" }),
    );
    assert.equal(
      snapshot(manager, "a@x.test").allowance!.windows["7d"].utilization,
      0.82,
    );
  }));

test("accounts that report no allowance stay sticky, skip a cooled-down one, and take turns", () =>
  withManager(
    ["a@x.test", "b@x.test"],
    (manager, advance) => {
      assert.equal(pick(manager), "a@x.test");
      for (let i = 0; i < 5; i++) assert.equal(pick(manager), "a@x.test");
      advance(STRETCH);
      assert.equal(pick(manager), "b@x.test");
      manager.recordFailure("b@x.test", "rate_limit");
      assert.equal(pick(manager), "a@x.test");
    },
    "codex",
  ));

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

test("a spent account's 429 is served by the other account, and the spent one sits out until it refills", async () => {
  const { manager, cleanup } = makeManager(["a@x.test", "b@x.test"]);
  try {
    const spent = allowanceHeaders({
      weekRefillsIn: 3 * HOUR,
      weekStatus: "rejected",
      status: "rejected",
    });
    const refill = Number(spent.get("anthropic-ratelimit-unified-reset"));
    spent.set("retry-after", "10800");
    const served: string[] = [];
    await proxyWithRetry("Test", mockResponse(), { debug: "off" } as any, {
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
    assert.equal(a.cooldownUntil, refill * 1000);
    assert.equal(a.allowance!.status, "rejected");
    assert.equal(
      snapshot(manager, "b@x.test").allowance!.windows["7d"].status,
      "allowed",
    );
    // Later requests go straight to b, without trying a first.
    assert.equal(pick(manager), "b@x.test");
  } finally {
    cleanup();
  }
});

test("Codex accounts keep the old backoff on a 429, whatever its Retry-After", async () => {
  const { manager, cleanup } = makeManager(["a@x.test", "b@x.test"], "codex");
  try {
    const before = Date.now();
    await proxyWithRetry("Test", mockResponse(), { debug: "off" } as any, {
      manager,
      upstream: async (account) =>
        account.token.email === "a@x.test"
          ? new Response("{}", {
              status: 429,
              headers: { "retry-after": "7200" },
            })
          : new Response("{}", { status: 200 }),
      success: async () => {},
    });
    const until = snapshot(manager, "a@x.test").cooldownUntil;
    assert.ok(until >= before + MINUTE && until <= Date.now() + MINUTE);
  } finally {
    cleanup();
  }
});
