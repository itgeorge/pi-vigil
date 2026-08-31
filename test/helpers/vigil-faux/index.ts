export {
  VIGIL_FAUX_DEFAULT_FALLBACK_TEXT,
  VIGIL_FAUX_MAX_DELAY_MS,
  VigilFauxScriptError,
  parseVigilFauxScript,
  type VigilFauxScript,
  type VigilFauxStep,
} from "./script.js";
export { createScriptMatcher, type VigilFauxScriptMatcher } from "./matcher.js";
export {
  VigilFauxPlaceholderError,
  extractLaunchIdsFromContext,
  substituteLaunchPlaceholders,
} from "./placeholders.js";

export const VIGIL_FAUX_PROVIDER_ID = "vigil-faux";
export const VIGIL_FAUX_MODEL_ID = "scripted";

export function getVigilFauxModelId(): string {
  return `${VIGIL_FAUX_PROVIDER_ID}/${VIGIL_FAUX_MODEL_ID}`;
}

export {
  buildVigilFauxPiChildArgs,
  createVigilFauxProcessRunner,
  getLocalVigilExtensionPath,
  getVigilFauxExtensionPath,
  insertVigilFauxExtensionArgs,
  writeVigilFauxScript,
  type CreateVigilFauxProcessRunnerOptions,
  type InsertVigilFauxExtensionArgsOptions,
} from "./process-runner.js";
export {
  readVigilLedgerFromSessionFile,
  readVigilNotifyEntriesFromSessionFile,
  spawnVigilFauxParentPi,
  type SpawnVigilFauxParentPiInput,
  type SpawnVigilFauxParentPiResult,
  type VigilLedgerEntries,
  type VigilNotifySessionEntry,
} from "./parent-spawn.js";
