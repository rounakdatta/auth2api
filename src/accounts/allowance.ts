/**
 * What Anthropic says about a subscription account's allowance. It rides on
 * every Messages response, success or 429, as `anthropic-ratelimit-unified-*`
 * headers (the ones Claude Code reads to show usage):
 *
 *   status          allowed | allowed_warning | rejected: is its limit hit?
 *   representative-claim  which limit that is: five_hour, seven_day, or
 *                   one model's own (seven_day_opus, seven_day_sonnet, ...)
 *   reset           epoch seconds when that limit refills
 *   5h-*, 7d-*      per window: utilization (a fraction, can pass 1), reset,
 *                   status (rejected once that window is spent)
 *   overage-status  allowed | rejected: may it carry on as paid extra usage?
 *
 * A hit limit refuses requests only when extra usage may not take over
 * (Claude Code's own rule): `rejected` with overage `allowed` still serves.
 *
 * Codex and Cursor responses carry none of these, and neither does
 * count_tokens, so for them this reads null.
 */

export interface AllowanceWindow {
  utilization: number | null;
  /** Epoch milliseconds. */
  resetsAt: number | null;
  status: string | null;
}

export interface Allowance {
  status: string | null;
  /** Which limit `status` and `resetsAt` describe. */
  claim: string | null;
  /** Epoch milliseconds when the limiting window refills. */
  resetsAt: number | null;
  windows: { [name: string]: AllowanceWindow };
  overage: string | null;
  /** Epoch milliseconds. */
  observedAt: number;
}

const PREFIX = "anthropic-ratelimit-unified-";
const WINDOWS = ["5h", "7d"];
// The limits that cover every model. A model's own cap leaves the account
// serving the others.
const ACCOUNT_WIDE = new Set(["five_hour", "seven_day"]);

function num(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function epochMs(value: string | null): number | null {
  const seconds = num(value);
  return seconds === null ? null : seconds * 1000;
}

export function readAllowance(
  headers: Headers,
  now = Date.now(),
): Allowance | null {
  const get = (name: string) => headers.get(PREFIX + name);
  const windows: Allowance["windows"] = {};
  for (const name of WINDOWS) {
    const window: AllowanceWindow = {
      utilization: num(get(`${name}-utilization`)),
      resetsAt: epochMs(get(`${name}-reset`)),
      status: get(`${name}-status`),
    };
    if (
      window.utilization !== null ||
      window.resetsAt !== null ||
      window.status !== null
    ) {
      windows[name] = window;
    }
  }
  const status = get("status");
  if (status === null && Object.keys(windows).length === 0) return null;
  return {
    status,
    claim: get("representative-claim"),
    resetsAt: epochMs(get("reset")),
    windows,
    overage: get("overage-status"),
    observedAt: now,
  };
}

/** Its limit is hit, but it carries on as paid extra usage. */
export function servesOnExtraUsage(allowance: Allowance): boolean {
  return (
    allowance.status === "rejected" &&
    (allowance.overage === "allowed" || allowance.overage === "allowed_warning")
  );
}

/**
 * When a 429'd account can serve again, by its own account. Undefined when
 * the response does not say, and the caller's own backoff applies.
 *   - five-hour or weekly allowance spent: its refill time
 *   - one model's cap spent: undefined, as the account still serves the
 *     other models
 *   - any other 429 (a burst, or one while on extra usage): Retry-After
 */
export function rateLimitedUntil(
  headers: Headers,
  now = Date.now(),
): number | undefined {
  const allowance = readAllowance(headers, now);
  const retryAfter = num(headers.get("retry-after"));
  const retryAt =
    retryAfter !== null && retryAfter > 0 ? now + retryAfter * 1000 : undefined;
  if (allowance?.status === "rejected" && !servesOnExtraUsage(allowance)) {
    if (!ACCOUNT_WIDE.has(allowance.claim ?? "")) return undefined;
    const until = allowance.resetsAt ?? retryAt;
    return until !== undefined && until > now ? until : undefined;
  }
  return retryAt;
}
