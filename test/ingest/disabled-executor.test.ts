import { describe, expect, it } from "vitest";

import {
  DisabledIngestTransferExecutor,
  IngestExecutionDisabledError,
  type AuthorizedIngestTransfer,
} from "../../src/ingest/index.js";

describe("DisabledIngestTransferExecutor", () => {
  it("fails closed", async () => {
    const executor = new DisabledIngestTransferExecutor();

    await expect(
      executor.execute({} as AuthorizedIngestTransfer),
    ).rejects.toBeInstanceOf(IngestExecutionDisabledError);
  });
});

