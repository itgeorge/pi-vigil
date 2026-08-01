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
import {
  formatListText,
  formatSnapshotText,
  formatWaitText,
  isVigilError,
  type VigilListResult,
  type VigilSnapshot,
} from "./vigil/types";

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
    childSessionNamer: overrides.childSessionNamer,
    waitScheduler: overrides.waitScheduler,
  });
}

export const vigilTool = defineTool({
  name: "vigil",
  label: "Vigil",
  description:
    "Launch, poll, continue, list, complete, or foreground-wait on detached Pi child sessions. Wait observes the current active cohort with bounded polling and never changes child state.",
  parameters: Type.Object({
    action: StringEnum(["launch", "poll", "send", "list", "complete", "wait"], {
      description:
        "launch starts a detached child session; poll reads status; send continues a waiting child; list returns the parent working set; complete retires a waiting child; wait boundedly observes the initial active cohort",
    }),
    name: Type.Optional(
      Type.String({
        description: "Human-readable Pi session name (required for launch)",
      }),
    ),
    message: Type.Optional(
      Type.String({
        description: "Prompt for the child session (required for launch and send)",
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
        description: "Vigil id returned by launch (required for poll, send, and complete)",
      }),
    ),
    includeCompleted: Type.Optional(
      Type.Boolean({
        description: "When listing, include completed children (default false)",
      }),
    ),
    timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds (default 60000, maximum 300000)" })),
    initialDelayMs: Type.Optional(Type.Number({ description: "Initial wait polling delay in milliseconds (default 500, maximum 30000)" })),
    maxDelayMs: Type.Optional(Type.Number({ description: "Maximum wait polling delay in milliseconds (default 5000, maximum 30000)" })),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const service = createService(ctx);

    if (params.action === "launch") {
      if (!params.name?.trim()) {
        return {
          content: [{ type: "text" as const, text: "launch requires name" }],
          details: { error: "launch requires name" },
          isError: true,
        };
      }

      if (!params.message) {
        return {
          content: [{ type: "text" as const, text: "launch requires message" }],
          details: { error: "launch requires message" },
          isError: true,
        };
      }

      const result = await service.launch({
        name: params.name,
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

    if (params.action === "wait") {
      const result = await service.wait(
        {
          timeoutMs: params.timeoutMs,
          initialDelayMs: params.initialDelayMs,
          maxDelayMs: params.maxDelayMs,
        },
        signal,
      );
      if (isVigilError(result)) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details: result,
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatWaitText(result) }],
        details: result,
      };
    }

    if (params.action === "list") {
      const result = await service.list(params.includeCompleted ?? false);
      if (isVigilError(result)) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details: result,
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: formatListText(result) }],
        details: result,
      };
    }

    if (params.action === "complete") {
      if (!params.id) {
        return {
          content: [{ type: "text" as const, text: "complete requires id" }],
          details: { error: "complete requires id" },
          isError: true,
        };
      }

      const result = await service.complete({
        vigilId: params.id,
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

    if (params.action === "send") {
      if (!params.id) {
        return {
          content: [{ type: "text" as const, text: "send requires id" }],
          details: { error: "send requires id" },
          isError: true,
        };
      }

      if (!params.message) {
        return {
          content: [{ type: "text" as const, text: "send requires message" }],
          details: { error: "send requires message" },
          isError: true,
        };
      }

      const result = await service.send({
        vigilId: params.id,
        message: params.message,
        model: params.model,
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
