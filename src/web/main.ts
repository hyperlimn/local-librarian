import { LocalWebRuntime } from "./runtime.js";

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const runtime = new LocalWebRuntime(options);
  const address = await runtime.server.start();
  const displayHost = address.host === "127.0.0.1" ? "localhost" : address.host;
  process.stdout.write(`Local Librarian is running at http://${displayHost}:${address.port}\n`);
  process.stdout.write(`Application state: ${runtime.stateDirectory}\n`);

  let closing = false;
  const close = (): void => {
    if (closing) return;
    closing = true;
    void runtime.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

function parseArguments(arguments_: readonly string[]): {
  readonly stateDirectory?: string;
  readonly staticDirectory?: string;
  readonly port?: number;
} {
  const result: { stateDirectory?: string; staticDirectory?: string; port?: number } = {};
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    const value = arguments_[index + 1];
    if (argument === "--state" && value !== undefined) {
      result.stateDirectory = value;
      index += 1;
    } else if (argument === "--static" && value !== undefined) {
      result.staticDirectory = value;
      index += 1;
    } else if (argument === "--port" && value !== undefined) {
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0 || port > 65_535) {
        throw new Error("--port must be an integer from 0 to 65535.");
      }
      result.port = port;
      index += 1;
    } else {
      throw new Error(`Unknown or incomplete WebUI argument: ${argument ?? ""}`);
    }
  }
  return result;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
