import { DecisionServiceError } from "../../../extensions/secretary/vm-use/decision-service-client.ts";
import { judgeStep, type PlanCheck, type PlanChecker, type PlanCheckState } from "../../../extensions/secretary/vm-use/online-check.ts";

/** One step's answers from the online API (design §8.3), or `undefined` for no usable answer. */
export type StepAnswer = { reach?: string; requested?: string } | undefined;

/**
 * An online plan check without the network: `answer` gives each step's answers, which the code's own
 * rule (`judgeStep`) turns into the approval marks. By default every step stays in the guest and is not requested.
 */
export function fakePlanChecker(answer: (step: PlanCheckState["steps"][number]) => StepAnswer = () => ({ reach: "guest", requested: "no" }),
  options: { failure?: string; roundTripMs?: number } = {}): PlanChecker & { states: PlanCheckState[] } {
  const states: PlanCheckState[] = [];
  return {
    states,
    async checkPlan(state: PlanCheckState, signal?: AbortSignal): Promise<PlanCheck> {
      states.push(state);
      if (signal?.aborted) throw new DecisionServiceError("aborted", "the online plan check was cancelled");
      if (options.failure) return { state, steps: state.steps.map(step => ({ id: step.id, needsApproval: true, why: "doubt" })), failure: options.failure, roundTripMs: options.roundTripMs ?? 1 };
      return { state, steps: state.steps.map(step => judgeStep(step.id, answer(step))), roundTripMs: options.roundTripMs ?? 1 };
    },
  };
}
