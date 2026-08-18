import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

import type { LocalApiRouter } from "./api-router.js";

export interface LocalWebServerOptions {
  readonly router: LocalApiRouter;
  readonly staticDirectory: string;
  readonly host?: "127.0.0.1" | "::1" | "localhost";
  readonly port?: number;
}

export class LocalWebServer {
  readonly #router: LocalApiRouter;
  readonly #staticDirectory: string;
  readonly #host: "127.0.0.1" | "::1" | "localhost";
  readonly #port: number;
  readonly #server: Server;

  public constructor(options: LocalWebServerOptions) {
    this.#router = options.router;
    this.#staticDirectory = resolve(options.staticDirectory);
    this.#host = options.host ?? "127.0.0.1";
    this.#port = options.port ?? 4_777;
    if (!Number.isInteger(this.#port) || this.#port < 0 || this.#port > 65_535) {
      throw new Error("The WebUI port must be an integer from 0 to 65535.");
    }
    this.#server = createServer((request, response) => {
      void this.handle(request, response);
    });
  }

  public start(): Promise<{ readonly host: string; readonly port: number }> {
    return new Promise((resolveStart, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#port, this.#host, () => {
        this.#server.off("error", onError);
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("The Local Librarian server did not expose a TCP address."));
          return;
        }
        resolveStart({ host: this.#host, port: address.port });
      });
    });
  }

  public close(): Promise<void> {
    return new Promise((resolveClose, reject) => {
      this.#server.close((error) => {
        if (error === undefined) resolveClose();
        else reject(error);
      });
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
      if (url.pathname.startsWith("/api/")) {
        await this.handleApi(request, response, url);
      } else if (request.method === "GET" || request.method === "HEAD") {
        await this.serveUi(request, response, url.pathname);
      } else {
        sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      }
    } catch (error) {
      const clientError = error instanceof ClientRequestError;
      sendJson(response, clientError ? 400 : 500, {
        error: {
          code: clientError ? error.code : "INTERNAL_ERROR",
          message: error instanceof Error ? error.message : "Local server error.",
        },
      });
    }
  }

  private async handleApi(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
  ): Promise<void> {
    if (request.method !== "GET" && request.method !== "POST") {
      sendJson(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } });
      return;
    }
    if (request.method === "POST" && !isAllowedOrigin(request.headers.origin, request.headers.host)) {
      sendJson(response, 403, { error: { code: "CROSS_ORIGIN_DENIED", message: "Cross-origin state changes are forbidden." } });
      return;
    }
    const body = request.method === "POST" ? await readJsonBody(request) : undefined;
    const result = await this.#router.dispatch({
      method: request.method,
      pathname: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      ...(body === undefined ? {} : { body }),
    });
    sendJson(response, result.status, result.body);
  }

  private async serveUi(
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
  ): Promise<void> {
    let filePath: string;
    if (pathname.startsWith("/assets/")) {
      filePath = resolve(this.#staticDirectory, `.${pathname}`);
      if (!filePath.startsWith(`${this.#staticDirectory}${sep}`)) {
        sendText(response, 404, "Not found");
        return;
      }
    } else {
      filePath = resolve(this.#staticDirectory, "index.html");
    }
    try {
      const contents = await readFile(filePath);
      response.statusCode = 200;
      response.setHeader("Content-Type", mimeType(filePath));
      response.setHeader("Cache-Control", pathname.startsWith("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-store");
      response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      response.setHeader("X-Content-Type-Options", "nosniff");
      if (request.method === "HEAD") response.end();
      else response.end(contents);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        sendText(response, 503, "Local Librarian WebUI has not been built. Run npm run build.");
        return;
      }
      throw error;
    }
  }
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers["content-type"];
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    length += buffer.length;
    if (length > 65_536) throw new ClientRequestError("BODY_TOO_LARGE", "The request body exceeds 64 KiB.");
    chunks.push(buffer);
  }
  if (length === 0) return undefined;
  if (typeof contentType !== "string" || !contentType.toLowerCase().startsWith("application/json")) {
    throw new ClientRequestError("INVALID_CONTENT_TYPE", "POST request bodies must use application/json.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ClientRequestError("INVALID_JSON", "The request body is not valid JSON.");
  }
}

function isAllowedOrigin(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const loopback = hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
    return parsed.protocol === "http:" && loopback && host !== undefined && parsed.host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

class ClientRequestError extends Error {
  public constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "ClientRequestError";
  }
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(`${JSON.stringify(body)}\n`);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(body);
}

function mimeType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    default:
      return "text/html; charset=utf-8";
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}
