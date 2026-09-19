import assert from "node:assert/strict";
import { test } from "node:test";
import { availabilityResetAt, isAvailabilityError, ModelAvailability } from "../../extensions/secretary/agents/availability.ts";

test("the availability classifier matches quota and cooldown failures only", () => {
  for (const message of [
    'OpenAI API error (429): {"message":"litellm.RateLimitError: model_cooldown: usage_limit_reached","code":"429"}',
    "429 Too Many Requests",
    "RateLimitError: rate limit exceeded",
    "The usage limit has been reached",
    "All credentials for model x are cooling down via provider codex",
    "insufficient_quota: quota exceeded",
    "Unknown model: provider/gone",
  ]) assert.equal(isAvailabilityError(message), true, message);
  for (const message of [
    "content policy violation",
    "Child produced no assistant response",
    "Child tool is not authorized: bash",
    "Model output limit reached",
    "Authentication unavailable for provider/model: missing credentials",
  ]) assert.equal(isAvailabilityError(message), false, message);
});

test("reset_seconds parsing yields an absolute reset time", () => {
  assert.equal(availabilityResetAt('"reset_seconds":65164', 1000), 1000 + 65164 * 1000);
  assert.equal(availabilityResetAt("reset_seconds=30", 1000), 31_000);
  assert.equal(availabilityResetAt("429 Too Many Requests", 1000), undefined);
});

test("the cache skips cooling-down models until their reset time and forgets expired entries", () => {
  let now = 1000;
  const cache = new ModelAvailability(() => now);
  cache.record("p/a", 2000);
  assert.match(cache.unavailable("p/a")!, /cooling/i);
  now = 2001;
  assert.equal(cache.unavailable("p/a"), undefined, "An expired reset time clears the entry");
  cache.record("p/b");
  assert.match(cache.unavailable("p/b")!, /cooling|quota/i);
  now += 100_000_000;
  assert.ok(cache.unavailable("p/b"), "A failure without a reset time lasts for the session");
  assert.equal(cache.unavailable("p/c"), undefined);
});
