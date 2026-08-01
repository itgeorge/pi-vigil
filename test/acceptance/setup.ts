import { beforeAll } from "vitest";
import { requireLiveAcceptanceEnv } from "./live-prereq";

beforeAll(() => {
  requireLiveAcceptanceEnv();
});
