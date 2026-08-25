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

/** Phase 0 stub — validation implemented in Phase 1. */
export function parseVigilFauxScript(input: unknown): VigilFauxScript {
  return input as VigilFauxScript;
}
