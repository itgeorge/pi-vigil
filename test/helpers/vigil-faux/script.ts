export const VIGIL_FAUX_DEFAULT_FALLBACK_TEXT =
  "fake model: doesn't support this request";

export type VigilFauxTextStep = {
  type: "text";
  text: string;
};

export type VigilFauxToolCallStep = {
  type: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
};

export type VigilFauxTextAndToolCallStep = {
  type: "textAndToolCall";
  text?: string;
  name: string;
  arguments: Record<string, unknown>;
};

export type VigilFauxStepThen =
  | VigilFauxTextStep
  | VigilFauxToolCallStep
  | VigilFauxTextAndToolCallStep;

export const VIGIL_FAUX_MAX_DELAY_MS = 60_000;

export type VigilFauxStep = {
  when: { userTextIncludes: string };
  then: VigilFauxStepThen;
  reusable?: boolean;
  delayMs?: number;
};

export interface VigilFauxScript {
  version: 1;
  fallbackText?: string;
  steps: VigilFauxStep[];
}

export class VigilFauxScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VigilFauxScriptError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseVigilFauxScript(input: unknown): VigilFauxScript {
  if (!isRecord(input)) {
    throw new VigilFauxScriptError("Invalid script: expected an object");
  }

  if (input.version !== 1) {
    throw new VigilFauxScriptError(`Unsupported script version: ${String(input.version)}`);
  }

  if (!Array.isArray(input.steps)) {
    throw new VigilFauxScriptError("Invalid script: missing steps array");
  }

  const steps = input.steps.map((step, index) => validateVigilFauxStep(step, index));

  return {
    version: 1,
    fallbackText: typeof input.fallbackText === "string" ? input.fallbackText : undefined,
    steps,
  };
}

function validateVigilFauxStep(step: unknown, index: number): VigilFauxStep {
  if (!isRecord(step)) {
    throw new VigilFauxScriptError(`Invalid script: step ${index} must be an object`);
  }

  if (!isRecord(step.when) || typeof step.when.userTextIncludes !== "string") {
    throw new VigilFauxScriptError(`Invalid script: step ${index} missing when.userTextIncludes`);
  }

  if (!isRecord(step.then)) {
    throw new VigilFauxScriptError(`Invalid script: step ${index} missing then`);
  }

  let delayMs: number | undefined;
  if (step.delayMs !== undefined) {
    if (typeof step.delayMs !== "number" || !Number.isInteger(step.delayMs)) {
      throw new VigilFauxScriptError(`Invalid script: step ${index} delayMs must be an integer`);
    }

    if (step.delayMs < 0) {
      throw new VigilFauxScriptError(`Invalid script: step ${index} delayMs must be >= 0`);
    }

    if (step.delayMs > VIGIL_FAUX_MAX_DELAY_MS) {
      throw new VigilFauxScriptError(
        `Invalid script: step ${index} delayMs must be <= ${VIGIL_FAUX_MAX_DELAY_MS}`,
      );
    }

    delayMs = step.delayMs;
  }

  return {
    when: { userTextIncludes: step.when.userTextIncludes },
    then: step.then as VigilFauxStepThen,
    reusable: step.reusable === true ? true : undefined,
    delayMs,
  };
}
