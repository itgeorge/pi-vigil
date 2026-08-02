import { describe, expect, it } from "vitest";
import { Text } from "@earendil-works/pi-tui";
import { MAX_ENTRY_DETAIL_CHARS, sanitizeDisplayMultiline } from "../../../src/vigil/transcript";
import { formatMutationSnapshotText, type VigilSnapshot } from "../../../src/vigil/types";
import { renderVigilResultText, type VigilResultRenderContext } from "../../../src/vigil/render-result";
import type { VigilCallArgs } from "../../../src/vigil/render-call";
import { createDeterministicTestTheme } from "../../helpers/test-theme";
import { createVigilTestHarness } from "../../helpers/vigil-test-harness";

const testTheme = createDeterministicTestTheme();

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function mutationResult(snapshot: VigilSnapshot, isError = false) {
  return {
    content: [{ type: "text" as const, text: formatMutationSnapshotText(snapshot) }],
    details: snapshot,
    ...(isError ? { isError: true } : {}),
  };
}

function renderPlainResult(
  result: ReturnType<typeof mutationResult>,
  args: VigilCallArgs,
  renderContext: VigilResultRenderContext = {},
) {
  const component = renderVigilResultText(result, args, testTheme, renderContext);
  return stripAnsi(component.render(120).join("\n").trim());
}

function renderHarnessResult(
  harness: Awaited<ReturnType<typeof createVigilTestHarness>>,
  result: ReturnType<typeof mutationResult>,
  args: VigilCallArgs,
  renderContext: VigilResultRenderContext = {},
) {
  const component = harness.tool.renderResult!(
    result,
    {
      expanded: renderContext.expanded ?? false,
      isPartial: renderContext.isPartial ?? false,
    },
    testTheme,
    {
      args,
      lastComponent: renderContext.lastComponent,
      expanded: renderContext.expanded ?? false,
      isPartial: renderContext.isPartial ?? false,
      isError: renderContext.isError ?? Boolean(result.isError),
      toolCallId: "test-call",
      invalidate: () => undefined,
      state: {},
      cwd: "/parent/project",
      executionStarted: true,
      argsComplete: true,
      showImages: false,
    } as never,
  );
  return stripAnsi(component.render(120).join("\n").trim());
}

const SAMPLE_UUID = "vigil-bd02f54e-1234-5678-abcd-ef0123456789";

describe("renderVigilResultText", () => {
  const runningSnapshot: VigilSnapshot = {
    id: SAMPLE_UUID,
    sessionId: SAMPLE_UUID,
    name: "Research API",
    cwd: "/parent/project",
    state: "running",
    latestResponse: null,
  };

  it("renders collapsed successful mutations compactly with an expand hint only when detail exists", () => {
    const sendCollapsed = renderPlainResult(
      mutationResult({ ...runningSnapshot, state: "waiting", latestResponse: "Old answer." }),
      { action: "send", id: SAMPLE_UUID, message: "Continue the work" },
    );
    expect(sendCollapsed).toContain("state: waiting");
    expect(sendCollapsed).toContain("to expand");
    expect(sendCollapsed).not.toContain("Continue the work");
    expect(sendCollapsed).not.toMatch(/Ctrl[-+]O/i);

    const launchCollapsed = renderPlainResult(
      mutationResult(runningSnapshot),
      { action: "launch", name: "Research API", message: "Hidden launch prompt" },
    );
    expect(launchCollapsed).toContain("state: running");
    expect(launchCollapsed).not.toContain("to expand");
    expect(launchCollapsed).not.toContain("Hidden launch prompt");

    const completeCollapsed = renderPlainResult(
      mutationResult({
        ...runningSnapshot,
        state: "completed",
        completedAt: "2026-08-01T12:00:00.000Z",
        latestResponse: "Final answer.",
        name: "[completed] Research API",
      }),
      { action: "complete", id: SAMPLE_UUID },
    );
    expect(completeCollapsed).toContain("state: completed");
    expect(completeCollapsed).toContain("to expand");
    expect(completeCollapsed).not.toContain("Final answer.");
  });

  it("renders expanded send detail from context args rather than details fields", () => {
    const expanded = renderPlainResult(
      mutationResult({ ...runningSnapshot, latestResponse: "Should not appear in send detail" }),
      { action: "send", id: SAMPLE_UUID, message: "Address reviewer feedback" },
      { expanded: true },
    );
    expect(expanded).toContain("sent message:");
    expect(expanded).toContain("Address reviewer feedback");
    expect(expanded).not.toContain("Should not appear in send detail");
  });

  it("renders expanded complete detail from details.latestResponse only on demand", () => {
    const expanded = renderPlainResult(
      mutationResult({
        ...runningSnapshot,
        state: "completed",
        completedAt: "2026-08-01T12:00:00.000Z",
        latestResponse: "Final child answer.",
        name: "[completed] Research API",
      }),
      { action: "complete", id: SAMPLE_UUID },
      { expanded: true },
    );
    expect(expanded).toContain("latest response:");
    expect(expanded).toContain("Final child answer.");

    const collapsed = renderPlainResult(
      mutationResult({
        ...runningSnapshot,
        state: "completed",
        completedAt: "2026-08-01T12:00:00.000Z",
        latestResponse: "Final child answer.",
        name: "[completed] Research API",
      }),
      { action: "complete", id: SAMPLE_UUID },
    );
    expect(collapsed).not.toContain("Final child answer.");
  });

  it("does not show launch message preview when expanded", () => {
    const expanded = renderPlainResult(
      mutationResult(runningSnapshot),
      { action: "launch", name: "Research API", message: "Hidden launch prompt" },
      { expanded: true },
    );
    expect(expanded).toContain("state: running");
    expect(expanded).not.toContain("Hidden launch prompt");
    expect(expanded).not.toContain("sent message:");
  });

  it("falls back to result content for non-mutation actions and errors", () => {
    const pollText = renderPlainResult(
      {
        content: [{ type: "text", text: "id: x\nlatestResponse: observe me" }],
        details: runningSnapshot,
      },
      { action: "poll", id: SAMPLE_UUID },
    );
    expect(pollText).toContain("latestResponse: observe me");

    const errorText = renderPlainResult(
      {
        content: [{ type: "text", text: "Unknown vigil id: vigil-missing" }],
        details: { error: "Unknown vigil id: vigil-missing" },
        isError: true,
      } as never,
      { action: "send", id: "vigil-missing", message: "Too late" },
      { isError: true },
    );
    expect(errorText).toBe("Unknown vigil id: vigil-missing");
  });

  it("sanitizes controls and caps expanded detail at 4000 visible characters", () => {
    const longMessage = `${"M".repeat(MAX_ENTRY_DETAIL_CHARS + 500)}\u001b[31mRED\u0007`;
    const expanded = renderPlainResult(
      mutationResult(runningSnapshot),
      { action: "send", id: SAMPLE_UUID, message: longMessage },
      { expanded: true },
    );
    expect(expanded).not.toMatch(/\u001b|\u0007/);
    const bounded = sanitizeDisplayMultiline(longMessage, MAX_ENTRY_DETAIL_CHARS);
    expect(bounded.length).toBeLessThanOrEqual(MAX_ENTRY_DETAIL_CHARS);
    expect(bounded).toContain("…");
    expect(expanded).toContain("sent message:");
    expect(expanded.replace(/\s+/g, "")).toContain(bounded.replace(/\s+/g, "").slice(0, 120));
    expect(expanded).not.toContain(longMessage.slice(-200));
  });

  it("handles malformed or missing details and args without throwing", () => {
    expect(() =>
      renderPlainResult(
        { content: [{ type: "text", text: "id: x\nstate: running" }] } as never,
        { action: "launch", name: "Task", message: "go" },
      ),
    ).not.toThrow();

    expect(() =>
      renderPlainResult(
        mutationResult(runningSnapshot),
        { action: "send", id: SAMPLE_UUID } as VigilCallArgs,
        { expanded: true },
      ),
    ).not.toThrow();
  });

  it("reuses a Text lastComponent when available", () => {
    const textComponent = new Text("", 0, 0);
    const reused = renderVigilResultText(
      mutationResult(runningSnapshot),
      { action: "launch", name: "Research API", message: "go" },
      testTheme,
      { lastComponent: textComponent },
    );
    expect(reused).toBe(textComponent);
  });
});

describe("vigil renderResult integration", () => {
  it("registers renderResult and does not mutate sessions when rendering", async () => {
    const harness = await createVigilTestHarness({ cwd: "/parent/project" });
    const appendCount = harness.capturedEntries.length;
    const snapshot: VigilSnapshot = {
      id: SAMPLE_UUID,
      sessionId: SAMPLE_UUID,
      name: "Adapter render child",
      cwd: "/parent/project",
      state: "running",
      latestResponse: null,
    };

    expect(harness.tool.renderResult).toBeDefined();
    renderHarnessResult(
      harness,
      mutationResult(snapshot),
      { action: "send", id: SAMPLE_UUID, message: "Continue" },
      { expanded: true },
    );

    expect(harness.capturedEntries).toHaveLength(appendCount);
  });
});
