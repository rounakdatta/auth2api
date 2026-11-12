/**
 * What Anthropic says about a subscription account's allowance. It rides on
 * every Messages response, success or 429, as `anthropic-ratelimit-unified-*`
 * headers (the ones Claude Code reads to show usage):
 *
 *   status          allowed | allowed_warning | rejected: is it refusing?
 *   reset           epoch seconds when the limiting window refills
 *   5h-*, 7d-*      per window: utilization (a fraction, can pass 1), reset,
 *                   status (rejected once that window is spent)
 *   overage-status  allowed | rejected: may it carry on as paid extra usage?
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
  /** Epoch milliseconds when the limiting window refills. */
  resetsAt: number | null;
  windows: { [name: string]: AllowanceWindow };
  overage: string | null;
  /** Epoch milliseconds. */
  observedAt: number;
}

const PREFIX = "anthropic-ratelimit-unified-";
const WINDOWS = ["5h", "7d"];

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
    resetsAt: epochMs(get("reset")),
    windows,
    overage: get("overage-status"),
    observedAt: now,
  };
}

/**
 * When a 429'd account can serve again, by its own account: the refill time
 * of a spent allowance, or else Retry-After in seconds. Undefined when the
 * response says neither, and the caller's own backoff applies.
 */
export function rateLimitedUntil(
  headers: Headers,
  now = Date.now(),
): number | undefined {
  const allowance = readAllowance(headers, now);
  if (
    allowance?.status === "rejected" &&
    allowance.resetsAt !== null &&
    allowance.resetsAt > now
  ) {
    return allowance.resetsAt;
  }
  const retryAfter = num(headers.get("retry-after"));
  return retryAfter !== null && retryAfter > 0
    ? now + retryAfter * 1000
    : undefined;
}
