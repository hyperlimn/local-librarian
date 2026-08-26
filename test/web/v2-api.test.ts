import { writeFile } from "node:fs/promises";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { localStatePaths } from "../../src/cli/local-state.js";
import type { InventoryScanId, JobId, WorkerId } from "../../src/domain/index.js";
import {
  AnalysisService,
  RECONCILIATION_JOB_DEFINITION,
  ReconciliationJobHandler,
  ScalableReconciliationService,
  SqliteIntelligenceStore,
} from "../../src/intelligence/index.js";
import {
  PersistentLocalWorker,
  SqlitePersistentJobQueue,
  type WorkerStatusView,
} from "../../src/jobs/index.js";
import {
  ORGANIZATION_EXECUTE_JOB_DEFINITION,
  ORGANIZATION_ROLLBACK_JOB_DEFINITION,
  OrganizationPlannerService,
  OrganizationService,
  SqliteOrganizationStore,
} from "../../src/organization/index.js";
import {
  INVENTORY_SCAN_JOB_DEFINITION,
  InventoryScanJobHandler,
} from "../../src/scanner/index.js";
import {
  SqliteTransferStore,
  TransferService,
} from "../../src/transfer/index.js";
import { LocalApiRouter } from "../../src/web/api-router.js";
import { LocalLibrarianApplication } from "../../src/web/application-service.js";
import type { DriveDiscovery } from "../../src/web/drive-discovery.js";
import type { WorkerManager } from "../../src/web/worker-process-manager.js";
import {
  createCatalog,
  createInventoryFixture,
  createRootGuard,
  type InventoryTestFixture,
} from "../inventory/test-helpers.js";

interface V2Harness {
  readonly fixture: InventoryTestFixture;
  readonly router: LocalApiRouter;
  readonly queue: SqlitePersistentJobQueue;
  readonly catalog: ReturnType<typeof createCatalog>;
  readonly intelligence: SqliteIntelligenceStore;
  readonly organization: SqliteOrganizationStore;
  readonly transfers: SqliteTransferStore;
  readonly worker: PersistentLocalWorker;
  cleanup(): Promise<void>;
}

const harnesses: V2Harness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
});

describe("Local Web API V2", () => {
  it("pages filtered intelligence and persisted reconciliation results", async () => {
    const harness = await createTrackedHarness();
    await Promise.all([
      writeFile(path.join(harness.fixture.rootPath, "alpha.pdf"), "%PDF-alpha", "utf8"),
      writeFile(path.join(harness.fixture.rootPath, "beta.pdf"), "%PDF-beta", "utf8"),
      writeFile(path.join(harness.fixture.rootPath, "photo.jpg"), "photo", "utf8"),
    ]);
    const baselineScanId = await scan(harness);

    await Promise.all([
      writeFile(path.join(harness.fixture.rootPath, "new-a.pdf"), "%PDF-new-a", "utf8"),
      writeFile(path.join(harness.fixture.rootPath, "new-b.pdf"), "%PDF-new-b", "utf8"),
    ]);
    const comparisonScanId = await scan(harness);
    const records = await harness.catalog.list(harness.fixture.root.id, {
      scanId: comparisonScanId,
      entryType: "file",
      limit: 100,
    });
    const now = new Date().toISOString();
    for (const record of records.items) {
      const document = record.extension === "pdf";
      await harness.intelligence.saveUnderstanding({
        recordId: record.id,
        rootId: record.rootId,
        scanId: record.scanId,
        relativePath: record.relativePath,
        parentPath: "",
        mimeType: document ? "application/pdf" : "image/jpeg",
        category: document ? "Documents" : "Images",
        confidence: 0.9,
        classificationLayer: "deterministic",
        explanation: "V2 API fixture classification.",
        evidence: { fixture: true },
        uncertainty: record.relativePath === "beta.pdf" ? "needs-review" : "confident",
        analysisState: "analyzed",
        metadata: {},
        updatedAt: now,
      });
    }
    const beta = records.items.find((record) => record.relativePath === "beta.pdf");
    expect(beta).toBeDefined();
    await harness.intelligence.createNeedsReview({
      id: "needs-review-v2:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      rootId: harness.fixture.root.id,
      scanId: comparisonScanId,
      recordId: beta!.id,
      reason: "low-classification-confidence",
      title: "Review beta.pdf",
      description: "The fixture deliberately marks this result for review.",
      evidence: { fixture: true },
      status: "open",
      createdAt: now,
    });

    const first = await dispatch(
      harness.router,
      "GET",
      `/api/libraries/${harness.fixture.root.id}/search?category=Documents&analysisState=analyzed&limit=1`,
    );
    expect(first.status).toBe(200);
    expect(items(first)).toHaveLength(1);
    const cursor = (first.body as { nextCursor?: string }).nextCursor;
    expect(cursor).toBeDefined();
    const second = await dispatch(
      harness.router,
      "GET",
      `/api/libraries/${harness.fixture.root.id}/search?category=Documents&analysisState=analyzed&limit=1&cursor=${encodeURIComponent(cursor!)}`,
    );
    expect(items(second)).toHaveLength(1);
    expect((items(second)[0] as { recordId: string }).recordId)
      .not.toBe((items(first)[0] as { recordId: string }).recordId);

    const reviewOnly = await dispatch(
      harness.router,
      "GET",
      `/api/libraries/${harness.fixture.root.id}/search?search=beta&needsReview=true`,
    );
    expect(items(reviewOnly)).toEqual([
      expect.objectContaining({
        relativePath: "beta.pdf",
        category: "Documents",
        needsReview: true,
      }),
    ]);
    const badFilter = await dispatch(
      harness.router,
      "GET",
      `/api/libraries/${harness.fixture.root.id}/search?needsReview=maybe`,
    );
    expect(badFilter).toMatchObject({
      status: 400,
      body: { error: { code: "INVALID_BOOLEAN" } },
    });

    const submitted = await dispatch(harness.router, "POST", "/api/reconciliation", {
      rootId: harness.fixture.root.id,
      baselineScanId,
      comparisonScanId,
    });
    expect(submitted).toMatchObject({ status: 200, body: { status: "queued" } });
    const reconciliationId = (submitted.body as { id: string }).id;
    expect(await harness.worker.runOnce()).toBe("worked");
    const completed = await dispatch(
      harness.router,
      "GET",
      `/api/reconciliations/${encodeURIComponent(reconciliationId)}`,
    );
    expect(completed.body).toMatchObject({
      status: "completed",
      counts: { added: 2, missing: 0, metadataChanged: 0 },
    });

    const deltaOne = await dispatch(
      harness.router,
      "GET",
      `/api/reconciliations/${encodeURIComponent(reconciliationId)}/deltas?kind=added&search=new-&limit=1`,
    );
    expect(items(deltaOne)).toHaveLength(1);
    const deltaCursor = (deltaOne.body as { nextCursor?: string }).nextCursor;
    expect(deltaCursor).toBeDefined();
    const deltaTwo = await dispatch(
      harness.router,
      "GET",
      `/api/reconciliations/${encodeURIComponent(reconciliationId)}/deltas?kind=added&search=new-&limit=1&cursor=${encodeURIComponent(deltaCursor!)}`,
    );
    expect(items(deltaTwo)).toHaveLength(1);
    expect((items(deltaTwo)[0] as { relativePath: string }).relativePath)
      .not.toBe((items(deltaOne)[0] as { relativePath: string }).relativePath);
  });
});

async function createTrackedHarness(): Promise<V2Harness> {
  const fixture = await createInventoryFixture();
  const paths = localStatePaths(fixture.statePath);
  const queue = new SqlitePersistentJobQueue({
    databasePath: fixture.jobsPath,
    definitions: [
      INVENTORY_SCAN_JOB_DEFINITION,
      ORGANIZATION_EXECUTE_JOB_DEFINITION,
      ORGANIZATION_ROLLBACK_JOB_DEFINITION,
      RECONCILIATION_JOB_DEFINITION,
    ],
  });
  const catalog = createCatalog(fixture.inventoryPath);
  const intelligence = new SqliteIntelligenceStore({ databasePath: fixture.inventoryPath });
  const organization = new SqliteOrganizationStore({ databasePath: paths.organizationDatabase });
  const transfers = new SqliteTransferStore(paths.transfersDatabase);
  const organizationService = new OrganizationService(
    new OrganizationPlannerService(
      catalog,
      fixture.store,
      organization,
      () => new Date(),
      process.platform === "win32" ? "win32" : "posix",
      intelligence,
    ),
    organization,
    queue,
    fixture.store,
  );
  const application = new LocalLibrarianApplication(
    fixture.service,
    fixture.store,
    queue,
    catalog,
    organizationService,
    { discover: () => Promise.resolve([]) } satisfies DriveDiscovery,
    new FakeWorkerManager(),
    paths,
    "2.0.0-test",
    {
      intelligence,
      analysis: new AnalysisService(catalog, fixture.store, queue, intelligence),
      reconciliation: new ScalableReconciliationService(intelligence, queue),
      transfers,
      transferService: new TransferService(
        transfers,
        queue,
        fixture.store,
        organization,
        catalog,
        intelligence,
      ),
    },
  );
  const worker = new PersistentLocalWorker({
    id: "v2-api-test-worker" as WorkerId,
    queue,
    handlers: [
      new InventoryScanJobHandler(createRootGuard(fixture.store), catalog),
      new ReconciliationJobHandler(intelligence),
    ],
  });
  const harness: V2Harness = {
    fixture,
    router: new LocalApiRouter(application),
    queue,
    catalog,
    intelligence,
    organization,
    transfers,
    worker,
    cleanup: async () => {
      transfers.close();
      organization.close();
      intelligence.close();
      catalog.close();
      queue.close();
      await fixture.cleanup();
    },
  };
  harnesses.push(harness);
  return harness;
}

async function scan(harness: V2Harness): Promise<InventoryScanId> {
  const submitted = await dispatch(
    harness.router,
    "POST",
    `/api/libraries/${harness.fixture.root.id}/scans`,
  );
  expect(submitted.status).toBe(202);
  const jobId = (submitted.body as { jobId: JobId }).jobId;
  expect(await harness.worker.runOnce()).toBe("worked");
  const inventoryScan = await harness.catalog.getScanByJob(jobId);
  if (inventoryScan === undefined) throw new Error("The V2 API fixture scan was not persisted.");
  return inventoryScan.id;
}

class FakeWorkerManager implements WorkerManager {
  public status(): Promise<WorkerStatusView> {
    return Promise.resolve({ status: "offline" });
  }

  public start(): Promise<WorkerStatusView> {
    return Promise.resolve({ status: "starting" });
  }
}

async function dispatch(
  router: LocalApiRouter,
  method: "GET" | "POST",
  rawPath: string,
  body?: unknown,
) {
  const url = new URL(rawPath, "http://localhost");
  return router.dispatch({
    method,
    pathname: url.pathname,
    query: Object.fromEntries(url.searchParams.entries()),
    ...(body === undefined ? {} : { body }),
  });
}

function items(response: { readonly body: unknown }): unknown[] {
  return (response.body as { items: unknown[] }).items;
}
