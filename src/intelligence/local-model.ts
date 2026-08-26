import type { JsonObject, JsonValue } from "../domain/index.js";
import type { FileUnderstanding, ResourceSettings } from "./types.js";

export interface LocalClassificationEvidence {
  readonly filename: string;
  readonly extension?: string;
  readonly parentPath: string;
  readonly mimeType?: string;
  readonly deterministicCategory: string;
  readonly deterministicConfidence: number;
  readonly metadata: JsonObject;
  readonly neighboringSignals: readonly string[];
}

export interface ValidatedLocalClassification {
  readonly category: string;
  readonly confidence: number;
  readonly explanation: string;
  readonly evidence: readonly string[];
  readonly uncertainty: "confident" | "needs-review";
}

export interface LocalModelClassifier {
  readonly id: string;
  classify(evidence: LocalClassificationEvidence): Promise<ValidatedLocalClassification>;
}

export function configuredLocalModel(
  settings: ResourceSettings,
): LocalModelClassifier | undefined {
  if (!settings.localModel.enabled || settings.localModel.model.trim().length === 0) return undefined;
  return settings.localModel.adapter === "ollama"
    ? new OllamaLocalClassifier(settings.localModel.endpoint, settings.localModel.model)
    : new StructuredHttpLocalClassifier(settings.localModel.endpoint, settings.localModel.model);
}

export function applyLocalClassification(
  current: FileUnderstanding,
  result: ValidatedLocalClassification,
  updatedAt: string,
): FileUnderstanding {
  return {
    ...current,
    category: result.category,
    confidence: result.confidence,
    classificationLayer: "local-model",
    explanation: result.explanation,
    evidence: { source: "optional-local-model", signals: result.evidence },
    uncertainty: result.uncertainty,
    updatedAt,
  };
}

class OllamaLocalClassifier implements LocalModelClassifier {
  public readonly id = "ollama";

  public constructor(
    private readonly endpoint: string,
    private readonly model: string,
  ) {
    assertLoopbackEndpoint(endpoint);
  }

  public async classify(evidence: LocalClassificationEvidence): Promise<ValidatedLocalClassification> {
    const response = await fetch(new URL("/api/generate", this.endpoint), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        format: "json",
        prompt: classificationPrompt(evidence),
        options: { temperature: 0 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Local Ollama classifier returned HTTP ${response.status}.`);
    const body = await response.json() as unknown;
    if (!isRecord(body) || typeof body["response"] !== "string") {
      throw new Error("Local Ollama classifier returned an invalid response.");
    }
    return validateClassification(JSON.parse(body["response"]) as unknown);
  }
}

class StructuredHttpLocalClassifier implements LocalModelClassifier {
  public readonly id = "structured-local-http";

  public constructor(
    private readonly endpoint: string,
    private readonly model: string,
  ) {
    assertLoopbackEndpoint(endpoint);
  }

  public async classify(evidence: LocalClassificationEvidence): Promise<ValidatedLocalClassification> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.model, task: "classify-file", evidence }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Local classifier returned HTTP ${response.status}.`);
    return validateClassification(await response.json() as unknown);
  }
}

function classificationPrompt(evidence: LocalClassificationEvidence): string {
  const compact = {
    filename: evidence.filename,
    ...(evidence.extension === undefined ? {} : { extension: evidence.extension }),
    parentPath: evidence.parentPath,
    ...(evidence.mimeType === undefined ? {} : { mimeType: evidence.mimeType }),
    deterministicCategory: evidence.deterministicCategory,
    deterministicConfidence: evidence.deterministicConfidence,
    metadata: privacyFilteredMetadata(evidence.metadata),
    neighboringSignals: evidence.neighboringSignals,
  };
  return [
    "Classify one file from compact local evidence. Never invent facts.",
    "Return only JSON with category, confidence (0..1), explanation, evidence (string array),",
    "and uncertainty ('confident' or 'needs-review'). Prefer needs-review when ambiguous.",
    JSON.stringify(compact),
  ].join("\n");
}

function privacyFilteredMetadata(value: JsonObject): JsonObject {
  const copy: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (["gps", "latitude", "longitude", "location"].includes(key.toLocaleLowerCase("en-US"))) continue;
    copy[key] = item;
  }
  return copy;
}

function validateClassification(value: unknown): ValidatedLocalClassification {
  if (!isRecord(value)) throw new Error("Local classifier output must be a JSON object.");
  const category = typeof value["category"] === "string" ? value["category"].trim() : "";
  const confidence = value["confidence"];
  const explanation = typeof value["explanation"] === "string" ? value["explanation"].trim() : "";
  const evidence = value["evidence"];
  const uncertainty = value["uncertainty"];
  if (category.length === 0 || category.length > 100) throw new Error("Local classifier category is invalid.");
  if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    throw new Error("Local classifier confidence is invalid.");
  }
  if (explanation.length === 0 || explanation.length > 1_000) {
    throw new Error("Local classifier explanation is invalid.");
  }
  if (!Array.isArray(evidence) || evidence.length > 20 || !evidence.every((item) => typeof item === "string" && item.length <= 500)) {
    throw new Error("Local classifier evidence is invalid.");
  }
  if (uncertainty !== "confident" && uncertainty !== "needs-review") {
    throw new Error("Local classifier uncertainty is invalid.");
  }
  return { category, confidence, explanation, evidence, uncertainty };
}

function assertLoopbackEndpoint(value: string): void {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]", "::1"].includes(url.hostname)) {
    throw new Error("Optional model endpoints must use HTTP loopback; remote inference is not allowed.");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
