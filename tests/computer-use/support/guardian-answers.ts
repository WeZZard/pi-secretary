import type { DecisionRequestBody, DecisionResponse } from "../../../extensions/secretary/computer-use/executor-client.ts";

/** Choices and confidences for the permission guardian's questions (permissions design §5). */
export type GuardAnswers = Partial<Record<"effect" | "reach" | "listed", readonly [string, number]>>;

/** A guardian request asks `effect` and `reach`, or `listed`; a step request asks none of them. */
export const isGuardianRequest = (body: DecisionRequestBody): boolean => "reach" in body.questions || "listed" in body.questions;

/**
 * Wraps an executor stub so that guardian requests are answered apart from step requests: by default
 * "none", "local" and "no", with confidence 0.9, which proceed in every environment.
 */
export function withGuardian<T extends { decide(body: DecisionRequestBody, signal?: AbortSignal): Promise<DecisionResponse> }>(
  executor: T, guard: (body: DecisionRequestBody) => GuardAnswers = () => ({}),
): T & { guardBodies: DecisionRequestBody[] } {
  const guardBodies: DecisionRequestBody[] = [];
  const decide = executor.decide.bind(executor);
  return Object.assign(executor, { guardBodies, decide: async (body: DecisionRequestBody, signal?: AbortSignal): Promise<DecisionResponse> => {
    if (!isGuardianRequest(body)) return decide(body, signal);
    guardBodies.push(body);
    const chosen: GuardAnswers = { effect: ["none", 0.9], reach: ["local", 0.9], listed: ["no", 0.9], ...guard(body) };
    return { roundTripMs: 1, answers: Object.fromEntries(Object.keys(body.questions).flatMap(id => chosen[id as keyof GuardAnswers]
      ? [[id, { choice: chosen[id as keyof GuardAnswers]![0], confidence: chosen[id as keyof GuardAnswers]![1] }]] : [])) };
  } });
}
