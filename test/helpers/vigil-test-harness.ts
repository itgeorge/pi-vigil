import type { Api, Model } from "@earendil-works/pi-ai";
import {
  SessionManager,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionEvent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerVigilExtension } from "../../src/index";

export interface CapturedEntry {
  customType: string;
  data: unknown;
}

export interface RegisteredFlag {
  name: string;
  options: {
    description?: string;
    type: "boolean" | "string";
    default?: boolean | string;
  };
}

export interface VigilTestHarness {
  tool: ToolDefinition;
  sessionManager: SessionManager;
  capturedEntries: CapturedEntry[];
  registeredFlags: RegisteredFlag[];
  ctx: ExtensionContext;
  emitExtensionEvent: (event: "session_start" | "session_tree") => Promise<void>;
  setFlag: (name: string, value: boolean | string | undefined) => void;
  execute: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content: Array<{ type: string; text?: string }>; details?: unknown }) => void,
  ) => ReturnType<ToolDefinition["execute"]>;
}

export async function createVigilTestHarness(options?: {
  cwd?: string;
  modelRegistry?: ExtensionContext["modelRegistry"];
  noSubagentsFlag?: boolean;
  skipSessionStart?: boolean;
}): Promise<VigilTestHarness> {
  const cwd = options?.cwd ?? process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  const capturedEntries: CapturedEntry[] = [];
  const registeredFlags: RegisteredFlag[] = [];
  const flagValues = new Map<string, boolean | string>();
  const eventHandlers = new Map<string, Array<(event: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>>>();

  const appendEntry: ExtensionAPI["appendEntry"] = (customType, data) => {
    capturedEntries.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  const registerFlag: ExtensionAPI["registerFlag"] = (name, flagOptions) => {
    registeredFlags.push({ name, options: flagOptions });
    if (flagOptions.default !== undefined) {
      flagValues.set(name, flagOptions.default);
    }
  };

  const getFlag: ExtensionAPI["getFlag"] = (name) => flagValues.get(name);

  let registeredTool: ToolDefinition | undefined;
  const api = {
    appendEntry,
    registerFlag,
    getFlag,
    registerTool: (tool: ToolDefinition) => {
      registeredTool = tool;
    },
    on: (event: string, handler: (event: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>) => {
      const handlers = eventHandlers.get(event) ?? [];
      handlers.push(handler);
      eventHandlers.set(event, handlers);
    },
  } as ExtensionAPI;

  registerVigilExtension(api);

  if (!registeredTool) {
    throw new Error("vigil tool was not registered");
  }

  const ctx = createExtensionContext(sessionManager, cwd, options?.modelRegistry);

  function setFlag(name: string, value: boolean | string | undefined): void {
    if (value === undefined) {
      flagValues.delete(name);
      return;
    }
    flagValues.set(name, value);
  }

  if (options?.noSubagentsFlag) {
    setFlag("vigil-no-subagents", true);
  }

  async function emitExtensionEvent(event: "session_start" | "session_tree"): Promise<void> {
    const payload = { type: event } as ExtensionEvent;
    for (const handler of eventHandlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  if (!options?.skipSessionStart) {
    await emitExtensionEvent("session_start");
  }

  return {
    tool: registeredTool,
    sessionManager,
    capturedEntries,
    registeredFlags,
    ctx,
    emitExtensionEvent,
    setFlag,
    execute: (params, signal, onUpdate) =>
      registeredTool!.execute("test-call-id", params, signal, onUpdate, ctx),
  };
}

function createExtensionContext(
  sessionManager: SessionManager,
  cwd: string,
  modelRegistry?: ExtensionContext["modelRegistry"],
): ExtensionContext {
  return {
    ui: {
      notify: () => undefined,
      notifyError: () => undefined,
      confirm: async () => true,
      input: async () => "",
      select: async () => undefined,
      custom: async () => undefined,
      pasteOverlay: () => ({ dispose: () => undefined }),
      setWorkingMessage: () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
      setFooter: () => undefined,
      setEditorComponent: () => undefined,
      setAutocompleteProvider: () => undefined,
      setTerminalInputHandler: () => undefined,
      setWorkingIndicator: () => undefined,
      editor: async () => "",
    },
    hasUI: false,
    cwd,
    sessionManager,
    modelRegistry:
      modelRegistry ??
      ({
        refresh: async () => undefined,
        getError: () => undefined,
        getAvailable: () => [] as Model<Api>[],
        getAll: () => [] as Model<Api>[],
      } as ExtensionContext["modelRegistry"]),
    model: undefined,
    isIdle: () => true,
    signal: undefined,
    abort: () => undefined,
    hasPendingMessages: () => false,
    shutdown: () => undefined,
    getContextUsage: () => undefined,
    compact: () => undefined,
    getSystemPrompt: () => "",
  } as unknown as ExtensionContext;
}
