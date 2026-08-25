import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type { VigilFauxScript } from "./script.js";

export interface VigilFauxScriptMatcher {
  match(context: Context): AssistantMessage;
}

/** Phase 0 stub — matcher logic implemented in Phase 1. */
export function createScriptMatcher(_script: VigilFauxScript): VigilFauxScriptMatcher {
  return {
    match(_context: Context): AssistantMessage {
      return fauxAssistantMessage("NOT_IMPLEMENTED");
    },
  };
}
