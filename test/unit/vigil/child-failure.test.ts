import { describe, expect, it } from "vitest";
import {
  classifyPersistedBootstrapFailure,
  parsePiStderrFailure,
} from "../../../src/vigil/child-failure";

const MODEL_NOT_FOUND_STDERR = `Error: Model "totally-invalid-model/foo" not found
`;

describe("parsePiStderrFailure", () => {
  it("extracts model not found message from fixture stderr", () => {
    expect(parsePiStderrFailure(MODEL_NOT_FOUND_STDERR)).toBe(
      'Model "totally-invalid-model/foo" not found',
    );
  });
});

describe("classifyPersistedBootstrapFailure", () => {
  it("returns error when process dead, session missing, and stderr has model error", () => {
    expect(
      classifyPersistedBootstrapFailure({
        alive: false,
        sessionExists: false,
        stderr: MODEL_NOT_FOUND_STDERR,
      }),
    ).toBe('Model "totally-invalid-model/foo" not found');
  });

  it("returns null when session exists (success path)", () => {
    expect(
      classifyPersistedBootstrapFailure({
        alive: false,
        sessionExists: true,
        stderr: MODEL_NOT_FOUND_STDERR,
      }),
    ).toBeNull();
  });

  it("returns null when process alive and session missing (still bootstrapping)", () => {
    expect(
      classifyPersistedBootstrapFailure({
        alive: true,
        sessionExists: false,
        stderr: MODEL_NOT_FOUND_STDERR,
      }),
    ).toBeNull();
  });
});
