import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { JobId } from "../../src/domain/index.js";
import { localStatePaths } from "../../src/cli/local-state.js";
import { LocalApiRouter } from "../../src/web/api-router.js";
import { LocalLibrarianApplication } from "../../src/web/application-service.js";
import type { DriveDiscovery } from "../../src/web/drive-discovery.js";
import type { WorkerManager } from "../../src/web/worker-process-manager.js";
import type { WorkerStatusView } from "../../src/jobs/index.js";
import {
  createCatalog,
  createInventoryFixture,
  createInventoryWorker,
  createJobQueue,
  type InventoryTestFixture,
} from "../inventory/test-helpers.js";

interface Harness {
  readonly fixture: InventoryTestFixture;
  readonly router: LocalApiRouter;
  readonly queue: ReturnType<typeof createJobQueue>;
  readonly catalog: ReturnType<typeof createCatalog>;
  readonly worker: FakeWorkerManager;
  cleanup(): Promise<void>;
}

const harnesses: Harness[] = [];
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("Local Web API", () => {
  it("validates bodies and identifiers and has no generic filesystem surface", async () => {
    const harness = await trackedHarness();
    await expectResponse(harness.router, "POST", "/api/enrollment/proposals", {
      path: harness.fixture.rootPath,
      displayName: "Duplicate",
      arbitraryPathRead: true,
    }, 400, "UNKNOWN_FIELD");
    await expectResponse(harness.router, "POST", "/api/libraries/not-a-root/scans", undefined, 400, "INVALID_IDENTIFIER");
    await expectResponse(harness.router, "GET", "/api/files", undefined, 404, "NOT_FOUND");
    await expectResponse(harness.router, "POST", "/api/filesystem/read", { path: harness.fixture.rootPath }, 404, "NOT_FOUND");
    await expectResponse(harness.router, "POST", "/api/filesystem/delete", { path: harness.fixture.rootPath }, 404, "NOT_FOUND");
  });

  it("keeps enrollment as proposal then explicit approval", async () => {
    const harness = await trackedHarness();
    const secondRoot = path.join(harness.fixture.directory, "second-library");
    await mkdir(secondRoot);
    const before = await dispatch(harness.router, "GET", "/api/libraries?includeRevoked=true");
    const proposalResponse = await dispatch(harness.router, "POST", "/api/enrollment/proposals", {
      path: secondRoot,
      displayName: "Second library",
    });
    expect(proposalResponse.status).toBe(201);
    const proposal = proposalResponse.body as { proposalId: string; approvalRequired: boolean; canonicalPath: string };
    expect(proposal).toMatchObject({ approvalRequired: true, canonicalPath: secondRoot });
    const stillUnchanged = await dispatch(harness.router, "GET", "/api/libraries?includeRevoked=true");
    expect(items(stillUnchanged)).toHaveLength(items(before).length);

    const approved = await dispatch(
      harness.router,
      "POST",
      `/api/enrollment/proposals/${proposal.proposalId}/approve`,
      { approvedBy: "web-test" },
    );
    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ approval: { status: "approved" }, policy: { allowWrites: false } });
    expect(items(await dispatch(harness.router, "GET", "/api/libraries?includeRevoked=true"))).toHaveLength(items(before).length + 1);
  });

  it("submits a durable scan without running work in the request and supports controls", async () => {
    const harness = await trackedHarness();
    const submitted = await dispatch(harness.router, "POST", `/api/libraries/${harness.fixture.root.id}/scans`);
    expect(submitted.status).toBe(202);
    const receipt = submitted.body as { jobId: JobId; status: string };
    expect(receipt.status).toBe("queued");
    expect(harness.worker.startCalls).toBe(0);
    expect(await harness.queue.status(receipt.jobId)).toMatchObject({ status: "queued" });

    expect((await dispatch(harness.router, "POST", `/api/jobs/${receipt.jobId}/pause`)).body).toMatchObject({ status: "paused" });
    expect((await dispatch(harness.router, "POST", `/api/jobs/${receipt.jobId}/resume`)).body).toMatchObject({ status: "queued" });
    expect((await dispatch(harness.router, "POST", `/api/jobs/${receipt.jobId}/cancel`)).body).toMatchObject({ status: "cancelled" });
  });

  it("rejects scan submission immediately after approval revocation", async () => {
    const harness = await trackedHarness();
    const revoked = await dispatch(harness.router, "POST", `/api/libraries/${harness.fixture.root.id}/revoke`, { reason: "Web test" });
    expect(revoked.status).toBe(200);
    await expectResponse(harness.router, "POST", `/api/libraries/${harness.fixture.root.id}/scans`, undefined, 409, "REQUEST_REJECTED");
    expect((await harness.queue.list()).items).toHaveLength(0);
  });

  it("paginates inventory through the API after an independent worker runs", async () => {
    const harness = await trackedHarness();
    for (const name of ["alpha.txt", "beta.jpg", "gamma.txt"]) {
      await writeFile(path.join(harness.fixture.rootPath, name), name, "utf8");
    }
    const submitted = await dispatch(harness.router, "POST", `/api/libraries/${harness.fixture.root.id}/scans`);
    const jobId = (submitted.body as { jobId: JobId }).jobId;
    expect((await harness.queue.get(jobId))?.status).toBe("queued");
    await createInventoryWorker(harness.queue, harness.catalog, harness.fixture.store).runOnce();

    const first = await dispatch(harness.router, "GET", `/api/libraries/${harness.fixture.root.id}/inventory?limit=2`);
    expect(items(first)).toHaveLength(2);
    const cursor = (first.body as { nextCursor?: string }).nextCursor;
    expect(cursor).toBeDefined();
    const second = await dispatch(harness.router, "GET", `/api/libraries/${harness.fixture.root.id}/inventory?limit=2&cursor=${encodeURIComponent(cursor!)}`);
    expect(items(second)).toHaveLength(1);
    const filtered = await dispatch(harness.router, "GET", `/api/libraries/${harness.fixture.root.id}/inventory?extension=txt&limit=10`);
    expect(items(filtered).map((record) => (record as { extension?: string }).extension)).toEqual(["txt", "txt"]);
  });

  it("reports drive metadata from discovery without invoking worker or scan", async () => {
    const harness = await trackedHarness();
    const response = await dispatch(harness.router, "GET", "/api/drives");
    expect(items(response)[0]).toMatchObject({ mountPath: harness.fixture.rootPath, classification: "fixed", enrollmentStatus: "enrolled" });
    expect(harness.worker.startCalls).toBe(0);
    expect((await harness.queue.list()).items).toHaveLength(0);
  });
});

async function createHarness(): Promise<Harness> {
  const fixture = await createInventoryFixture();
  const queue = createJobQueue(fixture.jobsPath);
  const catalog = createCatalog(fixture.inventoryPath);
  const worker = new FakeWorkerManager();
  const drives: DriveDiscovery = {
    discover: () => Promise.resolve([{
      mountPath: fixture.rootPath,
      classification: "fixed",
      filesystem: "testfs",
      totalBytes: 1_000,
      freeBytes: 400,
    }]),
  };
  const app = new LocalLibrarianApplication(
    fixture.service,
    fixture.store,
    queue,
    catalog,
    drives,
    worker,
    localStatePaths(fixture.statePath),
    "test-version",
  );
  return {
    fixture,
    router: new LocalApiRouter(app),
    queue,
    catalog,
    worker,
    cleanup: async () => { catalog.close(); queue.close(); await fixture.cleanup(); },
  };
}

async function trackedHarness(): Promise<Harness> {
  const harness = await createHarness();
  harnesses.push(harness);
  return harness;
}

class FakeWorkerManager implements WorkerManager {
  public startCalls = 0;
  public status(): Promise<WorkerStatusView> { return Promise.resolve({ status: "offline" }); }
  public start(): Promise<WorkerStatusView> { this.startCalls += 1; return Promise.resolve({ status: "starting" }); }
}

async function dispatch(router: LocalApiRouter, method: "GET" | "POST", rawPath: string, body?: unknown) {
  const url = new URL(rawPath, "http://localhost");
  return router.dispatch({
    method,
    pathname: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    ...(body === undefined ? {} : { body }),
  });
}

async function expectResponse(router: LocalApiRouter, method: "GET" | "POST", pathValue: string, body: unknown, status: number, code: string) {
  const response = await dispatch(router, method, pathValue, body);
  expect(response.status).toBe(status);
  expect(response.body).toMatchObject({ error: { code } });
}

function items(response: { readonly body: unknown }): unknown[] {
  return (response.body as { items: unknown[] }).items;
}
