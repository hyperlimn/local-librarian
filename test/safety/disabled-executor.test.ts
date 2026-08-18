import { describe, expect, it } from "vitest";

import {
  DisabledExecutor,
  ExecutionDisabledError,
} from "../../src/executor/index.js";
import type { PlanId } from "../../src/domain/index.js";
import type { AuthorizedOperation } from "../../src/safety/index.js";

describe("DisabledExecutor", () => {
  it("fails closed for execution and rollback", async () => {
    const executor = new DisabledExecutor();
    const operation = {} as AuthorizedOperation;
    const approval = {
      planId: "plan-1" as PlanId,
      approvedBy: "test-user",
      approvedAt: "2026-01-01T00:00:00.000Z",
    };

    await expect(executor.execute(operation, approval)).rejects.toBeInstanceOf(
      ExecutionDisabledError,
    );
    await expect(executor.rollback(operation, approval)).rejects.toBeInstanceOf(
      ExecutionDisabledError,
    );
  });
});

