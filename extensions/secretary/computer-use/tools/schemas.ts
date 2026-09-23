import { Type } from "typebox";

export const observeSchema = Type.Object({
  app: Type.String({ minLength: 1, maxLength: 200, description: "Application name as shown in the menu bar, for example TextEdit or Finder. The application must already be open." }),
  window_title: Type.Optional(Type.String({ minLength: 1, maxLength: 300, description: "Optional case-insensitive substring of the window title. Omit to use the frontmost titled window of the application." })),
}, { additionalProperties: false });

const OPERATIONS = ["press", "double_press", "context_press", "enter_text", "key_combo", "scroll_up", "scroll_down"] as const;

/** Postconditions are validated in code (verifier.ts) so the error names the exact problem. */
export const planStepSchema = Type.Object({
  id: Type.String({ minLength: 1, maxLength: 40, pattern: "^[A-Za-z0-9_-]+$" }),
  intent: Type.String({ minLength: 1, maxLength: 300, description: "One sentence saying what the step achieves, for example \"Open the File menu.\"" }),
  operation: Type.Optional(Type.Union(OPERATIONS.map(value => Type.Literal(value)), { description: "The expected operation, when known." })),
  text: Type.Optional(Type.String({ maxLength: 2000, description: "Complete literal text for enter_text. Only letters, digits, space, newline and tab can be typed." })),
  keys: Type.Optional(Type.String({ maxLength: 60, description: "A key combination for key_combo, for example cmd+shift+n or cmd+w." })),
  postcondition: Type.Unknown({ description: "One predicate object: {exists:{name,role?}}, {absent:{name,role?}}, {value:{name,equals}}, {window:{titleContains}}, {text:{contains}}, {changed:true}, {all:[...]}, or {any:[...]}. Only on-screen elements count." }),
  max_attempts: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })),
}, { additionalProperties: false });

export const runPlanSchema = Type.Object({
  app: Type.String({ minLength: 1, maxLength: 200, description: "Application name, as for computer_observe." }),
  window_title: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })),
  goal: Type.String({ minLength: 1, maxLength: 500, description: "The task goal in one sentence; the executor sees it at every step." }),
  based_on: Type.Optional(Type.String({ description: "The observation id this plan was written against." })),
  steps: Type.Array(planStepSchema, { minItems: 1, maxItems: 50 }),
  allow_destructive: Type.Optional(Type.Array(Type.String(), { description: "Step ids that may delete, send, purchase, overwrite, or close without saving. Name a step only when the delegated task authorizes it." })),
}, { additionalProperties: false });
