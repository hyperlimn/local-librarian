import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { LocalApiRequest, LocalApiResponse } from "../../src/web/api-router.js";
import { LocalWebServer } from "../../src/web/local-web-server.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("LocalWebServer", () => {
  it("binds to loopback, serves the SPA, and rejects cross-origin mutations", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "local-librarian-http-"));
    directories.push(directory);
    await writeFile(path.join(directory, "index.html"), "<!doctype html><title>Local Librarian test</title>", "utf8");
    const router = { dispatch: (_request: LocalApiRequest): Promise<LocalApiResponse> => Promise.resolve({ status: 200, body: { ok: true } }) };
    const server = new LocalWebServer({ router: router as never, staticDirectory: directory, port: 0 });
    const address = await server.start();
    try {
      expect(address.host).toBe("127.0.0.1");
      const base = `http://127.0.0.1:${address.port}`;
      const page = await fetch(base);
      expect(page.status).toBe(200);
      await expect(page.text()).resolves.toContain("Local Librarian test");
      const crossOrigin = await fetch(`${base}/api/test`, { method: "POST", headers: { Origin: "http://example.test", "Content-Type": "application/json" }, body: "{}" });
      expect(crossOrigin.status).toBe(403);
      const invalidJson = await fetch(`${base}/api/test`, { method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: "{" });
      expect(invalidJson.status).toBe(400);
      await expect(invalidJson.json()).resolves.toMatchObject({ error: { code: "INVALID_JSON" } });
    } finally {
      await server.close();
    }
  });
});
