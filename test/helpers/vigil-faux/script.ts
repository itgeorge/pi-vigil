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

export type VigilFauxStep = {
  when: { userTextIncludes: string };
  then: VigilFauxStepThen;
  reusable?: boolean;
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

  return {
    version: 1,
    fallbackText: typeof input.fallbackText === "string" ? input.fallbackText : undefined,
    steps: input.steps as VigilFauxStep[],
  };
}
