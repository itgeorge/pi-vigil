export {
  VIGIL_FAUX_DEFAULT_FALLBACK_TEXT,
  VigilFauxScriptError,
  parseVigilFauxScript,
  type VigilFauxScript,
  type VigilFauxStep,
} from "./script.js";
export { createScriptMatcher, type VigilFauxScriptMatcher } from "./matcher.js";

export const VIGIL_FAUX_PROVIDER_ID = "vigil-faux";
export const VIGIL_FAUX_MODEL_ID = "scripted";

export function getVigilFauxModelId(): string {
  return `${VIGIL_FAUX_PROVIDER_ID}/${VIGIL_FAUX_MODEL_ID}`;
}

export {
  buildVigilFauxPiChildArgs,
  createVigilFauxProcessRunner,
  getVigilFauxExtensionPath,
  insertVigilFauxExtensionArgs,
  writeVigilFauxScript,
  type CreateVigilFauxProcessRunnerOptions,
} from "./process-runner.js";
