/**
 * Client for the executor's `POST /v1/systemone` (design docs/arch/computer-use.md §7.1).
 * Contract read from mmastrac/djev-spark 1444f3e, server/structured_server.py: `questions` maps
 * an id to {type, instructions, criteria}; a choice's criteria map option names to descriptions;
 * a non-string state is sent as JSON; each choice answer carries `choice` and `confidence`.
 */

export interface ChoiceQuestion { type: "choice"; instructions: string; criteria: Record<string, string | null> }
/** `seed` is the deployed fork's extension. The service does not apply it: identical requests, with or without a seed, get different answers (research §18.1). */
export interface DecisionRequestBody { state: Record<string, unknown> | string; questions: Record<string, ChoiceQuestion>; samples: 1; seed?: number }
export interface ChoiceAnswer { choice: string; confidence: number }
export interface DecisionResponse {
  answers: Record<string, ChoiceAnswer | null>;
  /** The service's `usage.input_tokens`. */
  inputTokens?: number;
  /** The service's `usage.output_tokens`: the answer tokens its reads requested. */
  outputTokens?: number;
  /** Executor round-trip latency: harness-side time from sending the request to receiving the full response (design §12.2). */
  roundTripMs: number;
}

const CONTEXT_LENGTH = /maximum context length/i;

export class ExecutorError extends Error {
  /** `too_large`: the request does not fit the executor's model length, counted by the executor itself. */
  readonly code: "timeout" | "unreachable" | "rejected" | "too_large" | "failed" | "malformed" | "aborted";
  constructor(code: ExecutorError["code"], message: string) { super(message); this.name = "ExecutorError"; this.code = code; }
}

export type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export class ExecutorClient {
  readonly #url: string;
  readonly #timeoutMs: number;
  readonly #fetch: Fetch;
  readonly #now: () => number;
  constructor(options: { baseUrl: string; timeoutMs: number; fetch?: Fetch; now?: () => number }) {
    this.#url = `${options.baseUrl.replace(/\/+$/, "")}/v1/systemone`;
    this.#timeoutMs = options.timeoutMs;
    this.#fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.#now = options.now ?? (() => performance.now());
  }

  async decide(body: DecisionRequestBody, signal?: AbortSignal): Promise<DecisionResponse> {
    // A referenced timer, unlike AbortSignal.timeout, keeps the process alive until the deadline.
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.#timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
    const started = this.#now();
    let response: Awaited<ReturnType<Fetch>>;
    let text: string;
    try {
      response = await this.#fetch(this.#url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: combined });
      text = await response.text();
    } catch (error) {
      if (signal?.aborted) throw new ExecutorError("aborted", "the executor request was cancelled");
      if (timeout.signal.aborted) throw new ExecutorError("timeout", `the executor did not answer within ${this.#timeoutMs} ms`);
      throw new ExecutorError("unreachable", `the executor is unreachable: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
    const roundTripMs = this.#now() - started;
    // The service wraps vLLM's length rejection as HTTP 502 "upstream 400" (research §13).
    if (!response.ok && CONTEXT_LENGTH.test(text)) throw new ExecutorError("too_large", `the request does not fit the executor's model length: ${text.slice(0, 300)}`);
    if (response.status === 422) throw new ExecutorError("rejected", `the executor rejected the request: ${text.slice(0, 300)}`);
    if (!response.ok) throw new ExecutorError("failed", `the executor returned HTTP ${response.status}: ${text.slice(0, 300)}`);
    let parsed: { answers?: Record<string, { choice?: unknown; confidence?: unknown } | null>; usage?: { input_tokens?: unknown; output_tokens?: unknown } };
    try { parsed = JSON.parse(text); } catch { throw new ExecutorError("malformed", "the executor response is not JSON"); }
    if (!parsed.answers || typeof parsed.answers !== "object") throw new ExecutorError("malformed", "the executor response has no answers");
    const answers: Record<string, ChoiceAnswer | null> = {};
    for (const id of Object.keys(body.questions)) {
      const answer = parsed.answers[id];
      if (answer === null || answer === undefined) { answers[id] = null; continue; }
      if (typeof answer.choice !== "string" || typeof answer.confidence !== "number" || !(answer.choice in body.questions[id]!.criteria)) {
        throw new ExecutorError("malformed", `the executor's answer to ${id} is not one of its options`);
      }
      answers[id] = { choice: answer.choice, confidence: answer.confidence };
    }
    const inputTokens = typeof parsed.usage?.input_tokens === "number" ? parsed.usage.input_tokens : undefined;
    const outputTokens = typeof parsed.usage?.output_tokens === "number" ? parsed.usage.output_tokens : undefined;
    return { answers, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}), roundTripMs };
  }
}
