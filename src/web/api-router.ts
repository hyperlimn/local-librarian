import type {
  EnrolledRootId,
} from "../enrollment/index.js";
import type {
  InventoryRecordId,
  InventoryScanId,
  JobId,
  LibraryRootId,
} from "../domain/index.js";
import type { JobStatus } from "../jobs/index.js";
import type { LocalLibrarianApplication } from "./application-service.js";

export interface LocalApiRequest {
  readonly method: "GET" | "POST";
  readonly pathname: string;
  readonly query?: Readonly<Record<string, string | undefined>>;
  readonly body?: unknown;
}

export interface LocalApiResponse {
  readonly status: number;
  readonly body: unknown;
}

export class LocalApiRouter {
  public constructor(private readonly application: LocalLibrarianApplication) {}

  public async dispatch(request: LocalApiRequest): Promise<LocalApiResponse> {
    try {
      return await this.route(request);
    } catch (error) {
      if (error instanceof ApiInputError) {
        return {
          status: error.status,
          body: { error: { code: error.code, message: error.message } },
        };
      }
      const message = error instanceof Error ? error.message : "Local API request failed.";
      return {
        status: /not (?:currently )?approved|revok|cannot|already/iu.test(message) ? 409 : 400,
        body: { error: { code: "REQUEST_REJECTED", message } },
      };
    }
  }

  private async route(request: LocalApiRequest): Promise<LocalApiResponse> {
    const segments = splitPath(request.pathname);
    if (segments[0] !== "api") throw new ApiInputError(404, "NOT_FOUND", "API route not found.");

    if (request.method === "GET" && segments.length === 2 && segments[1] === "dashboard") {
      return ok(await this.application.dashboard());
    }
    if (request.method === "GET" && segments.length === 2 && segments[1] === "system") {
      return ok(await this.application.system());
    }
    if (request.method === "GET" && segments.length === 2 && segments[1] === "safety") {
      const [libraries, worker, system, auditIntegrity] = await Promise.all([
        this.application.libraries(true),
        this.application.workerStatus(),
        this.application.system(),
        this.application.verifyOrganizationAudit(),
      ]);
      return ok({ system, libraries, worker, auditIntegrity });
    }
    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[1] === "safety" &&
      segments[2] === "mutation-mode"
    ) {
      const body = objectBody(request.body, ["mode", "updatedBy", "confirmation"]);
      return ok(await this.application.setMutationMode(
        enumField(body, "mode", ["read-only", "live"] as const),
        stringField(body, "updatedBy", 200),
        stringField(body, "confirmation", 200),
      ));
    }
    if (request.method === "GET" && segments.length === 2 && segments[1] === "drives") {
      return ok({ items: await this.application.discoveredVolumes() });
    }
    if (request.method === "GET" && segments.length === 2 && segments[1] === "libraries") {
      return ok({ items: await this.application.libraries(booleanQuery(request.query?.["includeRevoked"], true)) });
    }
    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[1] === "enrollment" &&
      segments[2] === "proposals"
    ) {
      const body = objectBody(request.body, ["path", "displayName"]);
      const proposal = await this.application.proposeEnrollment({
        path: stringField(body, "path", 32_767),
        displayName: stringField(body, "displayName", 200),
      });
      return { status: 201, body: proposal };
    }
    if (
      request.method === "POST" &&
      segments.length === 5 &&
      segments[1] === "enrollment" &&
      segments[2] === "proposals" &&
      segments[4] === "approve"
    ) {
      const proposalId = identifier(segments[3], "proposal", /^[0-9a-f-]{36}$/iu);
      const body = objectBody(request.body, ["approvedBy"]);
      return ok(await this.application.approveEnrollment(
        proposalId,
        stringField(body, "approvedBy", 200),
      ));
    }
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[1] === "libraries" &&
      segments[3] === "revoke"
    ) {
      const rootId = libraryRootId(segments[2]);
      const body = objectBody(request.body, ["reason"]);
      return ok(await this.application.revokeEnrollment(
        rootId as EnrolledRootId,
        stringField(body, "reason", 500),
      ));
    }
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[1] === "libraries" &&
      segments[3] === "write-access"
    ) {
      const body = objectBody(request.body, ["allowWrites", "approvedBy", "confirmation"]);
      const allowWrites = booleanField(body, "allowWrites");
      const confirmation = stringField(body, "confirmation", 200);
      const expected = allowWrites ? "ENABLE LIBRARY WRITES" : "DISABLE LIBRARY WRITES";
      if (confirmation !== expected) {
        throw new ApiInputError(400, "CONFIRMATION_REQUIRED", `Type ${expected} to change library write access.`);
      }
      return ok(await this.application.setLibraryWriteAccess(
        libraryRootId(segments[2]),
        allowWrites,
        stringField(body, "approvedBy", 200),
      ));
    }
    if (
      request.method === "POST" &&
      segments.length === 4 &&
      segments[1] === "libraries" &&
      segments[3] === "scans"
    ) {
      const rootId = libraryRootId(segments[2]);
      return { status: 202, body: await this.application.startScan(rootId) };
    }
    if (
      request.method === "GET" &&
      segments.length === 4 &&
      segments[1] === "libraries" &&
      segments[3] === "summary"
    ) {
      return ok(await this.application.inventorySummary(libraryRootId(segments[2])));
    }
    if (
      request.method === "GET" &&
      segments.length === 4 &&
      segments[1] === "libraries" &&
      segments[3] === "inventory"
    ) {
      const entryType = optionalEnum(request.query?.["type"], [
        "file",
        "directory",
        "symbolic-link",
        "other",
        "unknown",
      ] as const, "inventory type");
      return ok(await this.application.inventoryList(libraryRootId(segments[2]), {
        limit: limitQuery(request.query?.["limit"], 100),
        ...optionalQueryValue(request.query?.["cursor"], "cursor", 4_096),
        ...optionalQueryValue(request.query?.["search"], "search", 200),
        ...optionalQueryValue(request.query?.["extension"], "extension", 50),
        ...(entryType === undefined ? {} : { entryType }),
        ...(request.query?.["scanId"] === undefined
          ? {}
          : { scanId: inventoryScanId(request.query["scanId"]) }),
      }));
    }
    if (
      request.method === "GET" &&
      segments.length === 3 &&
      segments[1] === "inventory"
    ) {
      return ok(await this.application.inventoryGet(inventoryRecordId(segments[2])));
    }
    if (request.method === "GET" && segments.length === 2 && segments[1] === "scans") {
      return ok(await this.application.scans({
        limit: limitQuery(request.query?.["limit"], 100),
        ...optionalQueryValue(request.query?.["cursor"], "cursor", 4_096),
        ...(request.query?.["rootId"] === undefined
          ? {}
          : { rootId: libraryRootId(request.query["rootId"]) }),
      }));
    }
    if (request.method === "GET" && segments.length === 3 && segments[1] === "scans") {
      const scan = await this.application.scan(inventoryScanId(segments[2]));
      if (scan === undefined) throw new ApiInputError(404, "SCAN_NOT_FOUND", "Scan not found.");
      return ok(scan);
    }
    if (
      request.method === "POST" &&
      segments.length === 2 &&
      segments[1] === "reconciliation"
    ) {
      const body = objectBody(request.body, [
        "rootId",
        "baselineScanId",
        "comparisonScanId",
      ]);
      const baselineScanId = inventoryScanId(stringField(body, "baselineScanId", 256));
      const comparisonScanId = inventoryScanId(stringField(body, "comparisonScanId", 256));
      if (baselineScanId === comparisonScanId) {
        throw new ApiInputError(
          400,
          "DISTINCT_SCANS_REQUIRED",
          "Choose two different completed scans to compare.",
        );
      }
      return ok(await this.application.compareScans(
        libraryRootId(stringField(body, "rootId", 256)),
        baselineScanId,
        comparisonScanId,
      ));
    }

    if (
      segments[1] === "organization" &&
      segments[2] === "plans" &&
      segments.length === 3
    ) {
      if (request.method === "GET") {
        return ok(await this.application.organizationPlans(
          request.query?.["rootId"] === undefined
            ? undefined
            : libraryRootId(request.query["rootId"]),
          limitQuery(request.query?.["limit"], 100),
          queryString(request.query?.["cursor"], "cursor", 4_096),
        ));
      }
      const body = objectBody(request.body, [
        "rootId", "strategy", "scope", "targetDirectory", "collisionPolicy",
        "includeHidden", "maximumOperations", "createdBy",
      ]);
      const strategy = optionalEnumField(
        body,
        "strategy",
        ["category", "category-and-year", "year-and-month"] as const,
      );
      const scope = optionalEnumField(body, "scope", ["top-level", "all-files"] as const);
      const collisionPolicy = optionalEnumField(
        body,
        "collisionPolicy",
        ["skip", "rename-with-suffix"] as const,
      );
      const targetDirectory = optionalStringField(body, "targetDirectory", 500);
      const includeHidden = optionalBooleanField(body, "includeHidden");
      const maximumOperations = optionalIntegerField(body, "maximumOperations", 1, 50_000);
      const plan = await this.application.createOrganizationPlan({
        rootId: libraryRootId(stringField(body, "rootId", 256)),
        createdBy: stringField(body, "createdBy", 200),
        ...(strategy === undefined ? {} : { strategy }),
        ...(scope === undefined ? {} : { scope }),
        ...(targetDirectory === undefined ? {} : { targetDirectory }),
        ...(collisionPolicy === undefined ? {} : { collisionPolicy }),
        ...(includeHidden === undefined ? {} : { includeHidden }),
        ...(maximumOperations === undefined ? {} : { maximumOperations }),
      });
      return { status: 201, body: plan };
    }
    if (
      segments[1] === "organization" &&
      segments[2] === "plans" &&
      segments.length >= 4
    ) {
      const planId = organizationPlanId(segments[3]);
      if (request.method === "GET" && segments.length === 4) {
        const plan = await this.application.organizationPlan(planId);
        if (plan === undefined) {
          throw new ApiInputError(404, "PLAN_NOT_FOUND", "Organization plan not found.");
        }
        return ok(plan);
      }
      if (request.method === "GET" && segments.length === 5 && segments[4] === "operations") {
        return ok(await this.application.organizationOperations(
          planId,
          limitQuery(request.query?.["limit"], 200),
          queryString(request.query?.["cursor"], "cursor", 4_096),
        ));
      }
      if (request.method === "POST" && segments.length === 5 && segments[4] === "runs") {
        const body = objectBody(request.body, ["mode", "approvedBy", "confirmation"]);
        return {
          status: 202,
          body: await this.application.startOrganizationRun({
            planId,
            mode: enumField(body, "mode", ["simulation", "live"] as const),
            approvedBy: stringField(body, "approvedBy", 200),
            confirmation: stringField(body, "confirmation", 200),
          }),
        };
      }
    }
    if (
      request.method === "GET" &&
      segments.length === 3 &&
      segments[1] === "organization" &&
      segments[2] === "runs"
    ) {
      return ok(await this.application.organizationRuns(
        queryString(request.query?.["planId"], "planId", 256),
        limitQuery(request.query?.["limit"], 100),
        queryString(request.query?.["cursor"], "cursor", 4_096),
      ));
    }
    if (
      segments[1] === "organization" &&
      segments[2] === "runs" &&
      segments.length >= 4
    ) {
      const runId = organizationRunId(segments[3]);
      if (request.method === "GET" && segments.length === 4) {
        const run = await this.application.organizationRun(runId);
        if (run === undefined) {
          throw new ApiInputError(404, "RUN_NOT_FOUND", "Organization run not found.");
        }
        return ok(run);
      }
      if (request.method === "GET" && segments.length === 5 && segments[4] === "items") {
        return ok(await this.application.organizationRunItems(
          runId,
          limitQuery(request.query?.["limit"], 200),
          queryString(request.query?.["cursor"], "cursor", 4_096),
        ));
      }
      if (request.method === "POST" && segments.length === 5 && segments[4] === "rollback") {
        const body = objectBody(request.body, ["mode", "approvedBy", "confirmation"]);
        return {
          status: 202,
          body: await this.application.startOrganizationRollback({
            sourceRunId: runId,
            mode: enumField(body, "mode", ["simulation", "live"] as const),
            approvedBy: stringField(body, "approvedBy", 200),
            confirmation: stringField(body, "confirmation", 200),
          }),
        };
      }
    }
    if (
      request.method === "GET" &&
      segments.length === 3 &&
      segments[1] === "organization" &&
      segments[2] === "audit"
    ) {
      return ok(await this.application.organizationAudit(
        limitQuery(request.query?.["limit"], 200),
        queryString(request.query?.["cursor"], "cursor", 4_096),
      ));
    }
    if (
      request.method === "GET" &&
      segments.length === 4 &&
      segments[1] === "organization" &&
      segments[2] === "audit" &&
      segments[3] === "integrity"
    ) {
      return ok(await this.application.verifyOrganizationAudit());
    }
    if (request.method === "GET" && segments.length === 2 && segments[1] === "jobs") {
      const status = optionalEnum(request.query?.["status"], [
        "queued",
        "running",
        "paused",
        "completed",
        "failed",
        "cancelled",
      ] as const, "job status") as JobStatus | undefined;
      return ok(await this.application.jobList({
        limit: limitQuery(request.query?.["limit"], 100),
        ...(status === undefined ? {} : { statuses: [status] }),
        ...optionalQueryValue(request.query?.["cursor"], "cursor", 4_096),
      }));
    }
    if (segments[1] === "jobs" && segments.length >= 3) {
      const jobId = validatedJobId(segments[2]);
      if (request.method === "GET" && segments.length === 3) {
        const job = await this.application.job(jobId);
        if (job === undefined) throw new ApiInputError(404, "JOB_NOT_FOUND", "Job not found.");
        return ok(job);
      }
      if (request.method === "GET" && segments.length === 4 && segments[3] === "history") {
        return ok(await this.application.jobHistory(jobId));
      }
      if (request.method === "GET" && segments.length === 4 && segments[3] === "result") {
        return ok(await this.application.jobResult(jobId));
      }
      if (request.method === "POST" && segments.length === 4) {
        if (segments[3] === "pause") return ok(await this.application.pauseJob(jobId));
        if (segments[3] === "resume") return ok(await this.application.resumeJob(jobId));
        if (segments[3] === "cancel") return ok(await this.application.cancelJob(jobId));
      }
    }
    if (request.method === "GET" && segments.length === 2 && segments[1] === "worker") {
      return ok(await this.application.workerStatus());
    }
    if (
      request.method === "POST" &&
      segments.length === 3 &&
      segments[1] === "worker" &&
      segments[2] === "start"
    ) {
      return { status: 202, body: await this.application.startWorker() };
    }

    throw new ApiInputError(404, "NOT_FOUND", "API route not found.");
  }
}

class ApiInputError extends Error {
  public constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiInputError";
  }
}

function ok(body: unknown): LocalApiResponse {
  return { status: 200, body };
}

function splitPath(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map(decodeURIComponent);
  } catch {
    throw new ApiInputError(400, "INVALID_PATH", "The request path is invalid.");
  }
}

function objectBody(body: unknown, allowedKeys: readonly string[]): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new ApiInputError(400, "INVALID_BODY", "A JSON object body is required.");
  }
  const object = body as Record<string, unknown>;
  const unexpected = Object.keys(object).find((key) => !allowedKeys.includes(key));
  if (unexpected !== undefined) {
    throw new ApiInputError(400, "UNKNOWN_FIELD", `Unknown request field: ${unexpected}.`);
  }
  return object;
}

function stringField(
  object: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string {
  const value = object[field];
  if (typeof value !== "string" || value.trim().length === 0 || value.length > maximumLength) {
    throw new ApiInputError(400, "INVALID_FIELD", `${field} must be a non-empty string.`);
  }
  return value.trim();
}
function enumField<const Values extends readonly string[]>(
  object: Record<string, unknown>,
  field: string,
  values: Values,
): Values[number] {
  const value = object[field];
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new ApiInputError(400, "INVALID_FIELD", `Invalid ${field}.`);
  }
  return value as Values[number];
}

function optionalEnumField<const Values extends readonly string[]>(
  object: Record<string, unknown>,
  field: string,
  values: Values,
): Values[number] | undefined {
  return object[field] === undefined ? undefined : enumField(object, field, values);
}

function optionalStringField(
  object: Record<string, unknown>,
  field: string,
  maximumLength: number,
): string | undefined {
  return object[field] === undefined ? undefined : stringField(object, field, maximumLength);
}

function booleanField(object: Record<string, unknown>, field: string): boolean {
  const value = object[field];
  if (typeof value !== "boolean") {
    throw new ApiInputError(400, "INVALID_FIELD", `${field} must be boolean.`);
  }
  return value;
}

function optionalBooleanField(
  object: Record<string, unknown>,
  field: string,
): boolean | undefined {
  return object[field] === undefined ? undefined : booleanField(object, field);
}

function optionalIntegerField(
  object: Record<string, unknown>,
  field: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const value = object[field];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ApiInputError(
      400,
      "INVALID_FIELD",
      `${field} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value;
}

function queryString(
  value: string | undefined,
  name: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (value.length > maximumLength) {
    throw new ApiInputError(400, "INVALID_QUERY", `${name} is too long.`);
  }
  return value;
}

function identifier(
  value: string | undefined,
  name: string,
  pattern: RegExp,
): string {
  if (value === undefined || value.length > 256 || !pattern.test(value)) {
    throw new ApiInputError(400, "INVALID_IDENTIFIER", `Invalid ${name} identifier.`);
  }
  return value;
}

function libraryRootId(value: string | undefined): LibraryRootId {
  return identifier(
    value,
    "library root",
    /^enrolled-root-v1:library:[0-9a-f]{64}$/u,
  ) as LibraryRootId;
}

function validatedJobId(value: string | undefined): JobId {
  return identifier(value, "job", /^job_[A-Za-z0-9_-]+$/u) as JobId;
}

function inventoryScanId(value: string | undefined): InventoryScanId {
  return identifier(value, "inventory scan", /^inventory-scan-v1:job_[A-Za-z0-9_-]+$/u) as InventoryScanId;
}

function inventoryRecordId(value: string | undefined): InventoryRecordId {
  return identifier(value, "inventory record", /^inventory-record-v1:[0-9a-f]{64}$/u) as InventoryRecordId;
}
function organizationPlanId(value: string | undefined): string {
  return identifier(
    value,
    "organization plan",
    /^organization-plan-v1:[0-9a-f-]{36}$/u,
  );
}

function organizationRunId(value: string | undefined): string {
  return identifier(
    value,
    "organization run",
    /^organization-run-v1:[0-9a-f-]{36}$/u,
  );
}

function limitQuery(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) {
    throw new ApiInputError(400, "INVALID_LIMIT", "limit must be an integer from 1 to 1000.");
  }
  return parsed;
}

function booleanQuery(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ApiInputError(400, "INVALID_BOOLEAN", "Expected true or false.");
}

function optionalQueryValue(
  value: string | undefined,
  key: "cursor" | "search" | "extension",
  maximumLength: number,
): { readonly cursor?: string; readonly search?: string; readonly extension?: string } {
  if (value === undefined || value.length === 0) return {};
  if (value.length > maximumLength) {
    throw new ApiInputError(400, "INVALID_QUERY", `${key} is too long.`);
  }
  return { [key]: value };
}

function optionalEnum<const Values extends readonly string[]>(
  value: string | undefined,
  values: Values,
  name: string,
): Values[number] | undefined {
  if (value === undefined || value.length === 0) return undefined;
  if (!(values as readonly string[]).includes(value)) {
    throw new ApiInputError(400, "INVALID_QUERY", `Invalid ${name}.`);
  }
  return value as Values[number];
}

