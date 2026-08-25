import { createFauxCore } from "@earendil-works/pi-ai";
import type { Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { setVigilRuntimeOverrides } from "../../../src/vigil/runtime-overrides.js";
import {
  createScriptMatcher,
  parseVigilFauxScript,
  VIGIL_FAUX_MODEL_ID,
  VIGIL_FAUX_PROVIDER_ID,
} from "./index.js";
import { createVigilFauxProcessRunner } from "./process-runner.js";

export default function vigilFauxExtension(pi: ExtensionAPI): void {
  const scriptPath = process.env.PI_VIGIL_FAUX_SCRIPT?.trim();
  if (!scriptPath) {
    throw new Error("PI_VIGIL_FAUX_SCRIPT is required for vigil-faux extension");
  }

  const script = parseVigilFauxScript(JSON.parse(readFileSync(scriptPath, "utf8")));

  if (process.env.PI_VIGIL_FAUX_BOOTSTRAP_RUNNER === "1") {
    setVigilRuntimeOverrides({
      processRunner: createVigilFauxProcessRunner({ loadLocalVigil: true }),
    });
  }

  const matcher = createScriptMatcher(script);
  const core = createFauxCore({
    provider: VIGIL_FAUX_PROVIDER_ID,
    api: "vigil-faux-api",
    models: [{ id: VIGIL_FAUX_MODEL_ID, name: "Vigil Faux Scripted" }],
  });

  const factory = (context: Parameters<typeof matcher.match>[0]) => matcher.match(context);

  const ensureFactoryQueued = () => {
    core.setResponses([
      async (context) => {
        ensureFactoryQueued();
        return factory(context);
      },
    ]);
  };

  ensureFactoryQueued();

  pi.registerProvider(VIGIL_FAUX_PROVIDER_ID, {
    name: "Vigil Faux",
    baseUrl: "faux://localhost",
    apiKey: "vigil-faux-test-key",
    api: core.api as Api,
    models: core.models.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: model.cost,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
    })),
    streamSimple: core.streamSimple as NonNullable<
      Parameters<ExtensionAPI["registerProvider"]>[1]["streamSimple"]
    >,
  });
}
