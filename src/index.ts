import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createVigilServiceForContext } from "./vigil/node-runtime";
import { getVigilSessionDir } from "./vigil/config";
import { getVigilRuntimeOverrides } from "./vigil/runtime-overrides";
import { formatSnapshotText, isVigilError, type VigilSnapshot } from "./vigil/types";

let appendEntryForTool: ExtensionAPI["appendEntry"] = () => {
  throw new Error("pi-vigil extension not initialized");
};

function createService(ctx: ExtensionContext) {
  const overrides = getVigilRuntimeOverrides();
  return createVigilServiceForContext({
    parentCwd: ctx.cwd,
    sessionManager: ctx.sessionManager,
    appendEntry: appendEntryForTool,
    sessionDir: overrides.sessionDir ?? getVigilSessionDir(),
    processRunner: overrides.processRunner,
    childSessionReader: overrides.childSessionReader,
  });
}

export const vigilTool = defineTool({
  name: "vigil",
  label: "Vigil",
  description:
    "Launch and poll detached Pi child sessions. Use action launch to start a child turn and poll to read running/waiting status plus the latest complete assistant response.",
  parameters: Type.Object({
    action: StringEnum(["launch", "poll"], {
      description: "launch starts a detached child session; poll reads its latest status",
    }),
    message: Type.Optional(
      Type.String({
        description: "Prompt for the child session (required for launch)",
      }),
    ),
    model: Type.Optional(
      Type.String({
        description: "Optional Pi model syntax such as openai-codex/gpt-5.5:high",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory for the child session (defaults to the parent cwd)",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description: "Vigil id returned by launch (required for poll)",
      }),
    ),
  }),

  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const service = createService(ctx);

    if (params.action === "launch") {
      if (!params.message) {
        return {
          content: [{ type: "text" as const, text: "launch requires message" }],
          details: { error: "launch requires message" },
          isError: true,
        };
      }

      const result = await service.launch({
        message: params.message,
        model: params.model,
        cwd: params.cwd,
        parentCwd: ctx.cwd,
      });

      if (isVigilError(result)) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details: result,
          isError: true,
        };
      }

      return snapshotResult(result);
    }

    if (!params.id) {
      return {
        content: [{ type: "text" as const, text: "poll requires id" }],
        details: { error: "poll requires id" },
        isError: true,
      };
    }

    const result = await service.poll(params.id);
    if (isVigilError(result)) {
      return {
        content: [{ type: "text" as const, text: result.error }],
        details: result,
        isError: true,
      };
    }

    return snapshotResult(result);
  },
});

function snapshotResult(snapshot: VigilSnapshot) {
  return {
    content: [{ type: "text" as const, text: formatSnapshotText(snapshot) }],
    details: snapshot,
  };
}

export function registerVigilExtension(pi: ExtensionAPI): ToolDefinition {
  appendEntryForTool = pi.appendEntry.bind(pi);
  pi.registerTool(vigilTool);
  return vigilTool;
}

export default function (pi: ExtensionAPI): void {
  registerVigilExtension(pi);
}
