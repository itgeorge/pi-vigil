import { StringEnum, Type } from "@earendil-works/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createVigilServiceForContext, shutdownSharedEphemeralChildObserver } from "./vigil/node-runtime";
import { getVigilSessionDir } from "./vigil/config";
import { appendThinkingLevelToModel } from "./vigil/model";
import { getVigilRuntimeOverrides } from "./vigil/runtime-overrides";
import {
  createVigilDisplayNameCache,
  renderVigilCallText,
  type VigilCallArgs,
} from "./vigil/render-call";
import { renderVigilResultText } from "./vigil/render-result";
import {
  formatListText,
  formatMutationSnapshotText,
  formatReadText,
  formatSearchText,
  formatSnapshotText,
  formatWaitText,
  isVigilError,
  type VigilListResult,
  type VigilReadResult,
  type VigilSearchResult,
  type VigilSnapshot,
} from "./vigil/types";
import { formatWaitProgressText } from "./vigil/wait-progress";
import type { VigilWaitProgress } from "./vigil/node-runtime";

let appendEntryForTool: ExtensionAPI["appendEntry"] = () => {
  throw new Error("pi-vigil extension not initialized");
};

const vigilDisplayNameCache = createVigilDisplayNameCache();

function refreshVigilDisplayNameCache(ctx: ExtensionContext): void {
  vigilDisplayNameCache.refreshFromBranch(() => ctx.sessionManager.getBranch());
}

function createService(ctx: ExtensionContext) {
  const overrides = getVigilRuntimeOverrides();
  return createVigilServiceForContext({
    parentCwd: ctx.cwd,
    sessionManager: ctx.sessionManager,
    appendEntry: appendEntryForTool,
    sessionDir: overrides.sessionDir ?? getVigilSessionDir(),
    processRunner: overrides.processRunner,
    childSessionReader: overrides.childSessionReader,
    childSessionTranscriptReader: overrides.childSessionTranscriptReader,
    childSessionNamer: overrides.childSessionNamer,
    descendantInspector: overrides.descendantInspector,
    ephemeralChildObserver: overrides.ephemeralChildObserver,
    waitScheduler: overrides.waitScheduler,
  });
}

export const vigilTool = defineTool({
  name: "vigil",
  label: "Vigil",
  description:
    "Launch, poll, continue, list, complete, foreground-wait, search, or read detached Pi child sessions. Wait observes the current active cohort or one targeted direct child with bounded polling and never changes child state. Pass ephemeral: true on launch for a single-turn child that does not create a Pi session or /resume entry.",
  parameters: Type.Object({
    action: StringEnum(["launch", "poll", "send", "list", "complete", "wait", "search", "read"], {
      description:
        "launch starts a detached child session; poll reads status; send continues a waiting child; list returns the parent working set; complete retires a waiting child; wait boundedly observes the initial active cohort or one targeted direct child; search finds literal matches in child transcripts; read inspects a stable child entry with nearby JSONL context",
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
    ephemeral: Type.Optional(
      Type.Boolean({
        description:
          "For launch only: run a single-turn ephemeral child with pi --no-session (no child JSONL or /resume entry). Parent Vigil lifecycle/settle metadata is still persisted.",
      }),
    ),
    id: Type.Optional(
      Type.String({
        description:
          "Vigil id returned by launch (required for poll, send, complete, and read; optional search filter or wait target)",
      }),
    ),
    query: Type.Optional(
      Type.String({
        description: "Case-insensitive literal substring to search child transcripts (required for search)",
      }),
    ),
    entryId: Type.Optional(
      Type.String({
        description: "Stable Pi child-session entry id from search (required for read)",
      }),
    ),
    before: Type.Optional(
      Type.Number({
        description: "Nearby JSONL entries before the anchor entry for read (default 1, maximum 10)",
      }),
    ),
    after: Type.Optional(
      Type.Number({
        description: "Nearby JSONL entries after the anchor entry for read (default 1, maximum 10)",
      }),
    ),
    maxResults: Type.Optional(
      Type.Number({
        description: "Maximum list items or search matches to return (default 20, maximum 50)",
      }),
    ),
    skipToId: Type.Optional(
      Type.String({
        description:
          "For list only: inclusive cursor — page begins at this exact Vigil child id in most-recent-first filtered order",
      }),
    ),
    includeCompleted: Type.Optional(
      Type.Boolean({
        description:
          "When listing or searching, include completed children (default false). Required to search/read an explicitly completed child.",
      }),
    ),
    timeoutMs: Type.Optional(Type.Number({ description: "Wait timeout in milliseconds (default 60000, maximum 300000)" })),
    initialDelayMs: Type.Optional(Type.Number({ description: "Initial wait polling delay in milliseconds (default 500, maximum 30000)" })),
    maxDelayMs: Type.Optional(Type.Number({ description: "Maximum wait polling delay in milliseconds (default 5000, maximum 30000)" })),
    progress: Type.Optional(
      StringEnum(["status", "none"], {
        description:
          'Foreground wait progress updates: "status" emits factual persisted-activity partial updates (default), "none" is silent',
      }),
    ),
    progressIntervalMs: Type.Optional(
      Type.Number({
        description:
          "Heartbeat cap for unchanged child-state progress between polls in milliseconds (default 30000, maximum 60000; ignored when progress is none). Elapsed timing still updates after every wait poll.",
      }),
    ),
    allowIncompleteSubagents: Type.Optional(
      Type.Boolean({
        description:
          "For complete only: allow retiring a settled direct child even when its own direct Vigil subagents remain incomplete. Does not kill, complete, or modify descendants.",
      }),
    ),
  }),

  renderCall(args, theme, context) {
    return renderVigilCallText(
      args as VigilCallArgs,
      theme,
      vigilDisplayNameCache.lookup(),
      {
        lastComponent: context.lastComponent,
        expanded: context.expanded,
      },
    );
  },

  renderResult(result, options, theme, context) {
    return renderVigilResultText(
      result,
      context.args as VigilCallArgs,
      theme,
      {
        lastComponent: context.lastComponent,
        expanded: options.expanded,
        isPartial: options.isPartial,
        isError: context.isError,
      },
    );
  },

  async execute(_toolCallId, params, signal, onUpdate, ctx) {
    if (params.ephemeral === true && params.action !== "launch") {
      return {
        content: [{ type: "text" as const, text: "ephemeral is only valid for launch" }],
        details: { error: "ephemeral is only valid for launch" },
        isError: true,
      };
    }

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
        model: appendThinkingLevelToModel(params.model, ctx.thinkingLevel),
        cwd: params.cwd,
        parentCwd: ctx.cwd,
        ephemeral: params.ephemeral,
      });

      if (isVigilError(result)) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details: result,
          isError: true,
        };
      }

      refreshVigilDisplayNameCache(ctx);
      return mutationSnapshotResult(result);
    }

    if (params.action === "wait") {
      const result = await service.wait(
        {
          id: params.id,
          timeoutMs: params.timeoutMs,
          initialDelayMs: params.initialDelayMs,
          maxDelayMs: params.maxDelayMs,
          progress:
            params.progress === "none" || params.progress === "status" ? params.progress : undefined,
          progressIntervalMs: params.progressIntervalMs,
        },
        signal,
        params.progress === "none"
          ? undefined
          : (progress) => {
              onUpdate?.({
                content: [{ type: "text" as const, text: formatWaitProgressText(progress, Date.now()) }],
                details: progress as VigilWaitProgress,
              });
            },
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
      const result = await service.list({
        includeCompleted: params.includeCompleted,
        maxResults: params.maxResults,
        skipToId: params.skipToId,
      });
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
        allowIncompleteSubagents: params.allowIncompleteSubagents,
      });

      if (isVigilError(result)) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details: result,
          isError: true,
        };
      }

      refreshVigilDisplayNameCache(ctx);
      return mutationSnapshotResult(result);
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
        model: appendThinkingLevelToModel(params.model, ctx.thinkingLevel),
        parentCwd: ctx.cwd,
      });

      if (isVigilError(result)) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details: result,
          isError: true,
        };
      }

      return mutationSnapshotResult(result);
    }

    if (params.action === "search") {
      const result = await service.search({
        query: params.query ?? "",
        id: params.id,
        includeCompleted: params.includeCompleted,
        maxResults: params.maxResults,
      });
      if (isVigilError(result)) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details: result,
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatSearchText(result) }],
        details: result as VigilSearchResult,
      };
    }

    if (params.action === "read") {
      if (!params.id) {
        return {
          content: [{ type: "text" as const, text: "read requires id" }],
          details: { error: "read requires id" },
          isError: true,
        };
      }
      if (!params.entryId) {
        return {
          content: [{ type: "text" as const, text: "read requires entryId" }],
          details: { error: "read requires entryId" },
          isError: true,
        };
      }

      const result = await service.read({
        id: params.id,
        entryId: params.entryId,
        before: params.before,
        after: params.after,
        includeCompleted: params.includeCompleted,
      });
      if (isVigilError(result)) {
        return {
          content: [{ type: "text" as const, text: result.error }],
          details: result,
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: formatReadText(result) }],
        details: result as VigilReadResult,
      };
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

function mutationSnapshotResult(snapshot: VigilSnapshot) {
  return {
    content: [{ type: "text" as const, text: formatMutationSnapshotText(snapshot) }],
    details: snapshot,
  };
}

function snapshotResult(snapshot: VigilSnapshot) {
  return {
    content: [{ type: "text" as const, text: formatSnapshotText(snapshot) }],
    details: snapshot,
  };
}

export function registerVigilExtension(pi: ExtensionAPI): ToolDefinition {
  appendEntryForTool = pi.appendEntry.bind(pi);

  pi.on("session_start", (_event, ctx) => {
    refreshVigilDisplayNameCache(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    refreshVigilDisplayNameCache(ctx);
  });

  pi.on("session_shutdown", async () => {
    await shutdownSharedEphemeralChildObserver();
  });

  pi.registerTool(vigilTool);
  return vigilTool;
}

export default function (pi: ExtensionAPI): void {
  registerVigilExtension(pi);
}
