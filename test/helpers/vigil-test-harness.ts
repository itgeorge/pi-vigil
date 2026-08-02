import {
  createExtensionRuntime,
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

export interface VigilTestHarness {
  tool: ToolDefinition;
  sessionManager: SessionManager;
  capturedEntries: CapturedEntry[];
  ctx: ExtensionContext;
  emitExtensionEvent: (event: "session_start" | "session_tree") => Promise<void>;
  execute: (
    params: Record<string, unknown>,
    signal?: AbortSignal,
    onUpdate?: (update: { content: Array<{ type: string; text?: string }>; details?: unknown }) => void,
  ) => ReturnType<ToolDefinition["execute"]>;
}

export async function createVigilTestHarness(options?: {
  cwd?: string;
}): Promise<VigilTestHarness> {
  const cwd = options?.cwd ?? process.cwd();
  const sessionManager = SessionManager.inMemory(cwd);
  const capturedEntries: CapturedEntry[] = [];
  const runtime = createExtensionRuntime();
  const eventHandlers = new Map<string, Array<(event: ExtensionEvent, ctx: ExtensionContext) => void | Promise<void>>>();

  runtime.appendEntry = (customType, data) => {
    capturedEntries.push({ customType, data });
    sessionManager.appendCustomEntry(customType, data);
  };

  let registeredTool: ToolDefinition | undefined;
  const api = {
    appendEntry: runtime.appendEntry,
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

  const ctx = createExtensionContext(sessionManager, cwd);

  async function emitExtensionEvent(event: "session_start" | "session_tree"): Promise<void> {
    const payload = { type: event } as ExtensionEvent;
    for (const handler of eventHandlers.get(event) ?? []) {
      await handler(payload, ctx);
    }
  }

  await emitExtensionEvent("session_start");

  return {
    tool: registeredTool,
    sessionManager,
    capturedEntries,
    ctx,
    emitExtensionEvent,
    execute: (params, signal, onUpdate) =>
      registeredTool!.execute("test-call-id", params, signal, onUpdate, ctx),
  };
}

function createExtensionContext(sessionManager: SessionManager, cwd: string): ExtensionContext {
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
    modelRegistry: {} as ExtensionContext["modelRegistry"],
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
