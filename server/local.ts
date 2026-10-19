import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { IntakeError, IntakeService, type IntakeOptions } from "./intake";
import { FileControlStore } from "./control-store";

export function intakeHandler(service: IntakeService, allowedOrigin: string) {
  const limits = new Map<string, { count: number; expires: number }>();
  return async (request: IncomingMessage, response: ServerResponse) => {
    const send = (status: number, body: unknown) => {
      response.writeHead(status, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(JSON.stringify(body));
    };
    if (request.url !== "/intake/demo" || request.method !== "POST") {
      send(404, { message: "Not found." });
      return;
    }
    if (request.headers.origin !== allowedOrigin) {
      send(403, { message: "Submit from the configured local form." });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
      send(415, { message: "JSON is required." });
      return;
    }
    const now = Date.now();
    for (const [key, limit] of limits) if (limit.expires <= now) limits.delete(key);
    const address = request.socket.remoteAddress ?? "unknown";
    const limit = limits.get(address) ?? { count: 0, expires: now + 60000 };
    if (limit.count >= 20 || limits.size >= 500) {
      response.setHeader("Retry-After", "60");
      send(429, { message: "Too many requests. Retry in a minute." });
      return;
    }
    limit.count++;
    limits.set(address, limit);
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += Buffer.byteLength(chunk);
        if (size > 12000) {
          send(413, { message: "Request is too large." });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let raw: unknown;
      try {
        raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new IntakeError(400, "Invalid JSON.");
      }
      send(202, await service.submit(raw));
    } catch (error) {
      if (error instanceof IntakeError && error.status < 500) send(error.status, { message: error.message });
      else
        send(503, {
          message:
            "Demo intake is temporarily unavailable. Retry this submission without changing its fields.",
        });
    }
  };
}

export async function startLocalIntake(options: IntakeOptions, port: number, origin: string) {
  const service = await IntakeService.open(options);
  const server = createServer(intakeHandler(service, origin));
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", resolve);
    });
  } catch (error) {
    await service.close();
    throw error;
  }
  server.on("close", () => {
    void service.close();
  });
  return { server, service };
}

async function main() {
  const token = process.env.KANBUS_LOCAL_TOKEN;
  const api = process.env.PROSPECTUS_LOCAL_API_URL ?? "http://127.0.0.1:5492/api";
  const url = new URL(api);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/api" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("The demo adapter only accepts a loopback Kanbus API.");
  if (!token || token.length < 16) throw new Error("A server-only local Kanbus token is required.");
  const { server } = await startLocalIntake(
    {
      directory: process.env.PROSPECTUS_INTAKE_LEDGER ?? "local-data/intake",
      workspace: "cyclotron/prospectus",
      owner: "local-member",
      siteId: "prospectus-web-review",
      formId: "demo-v1",
      identityStore: new FileControlStore(
        process.env.PROSPECTUS_IDENTITY_DIRECTORY ?? "local-data/review/identity-claims",
      ),
      request: async (path, init = {}) => {
        const headers = new Headers(init.headers);
        headers.set("Authorization", `Bearer ${token}`);
        const result = await fetch(`${api}${path}`, { ...init, headers, signal: AbortSignal.timeout(10000) });
        if (!result.ok) {
          const failure = (await result.json().catch(() => ({}))) as { error?: unknown };
          throw new IntakeError(
            result.status,
            "The private workspace could not accept this request.",
            typeof failure.error === "string" ? failure.error : undefined,
          );
        }
        return result.json();
      },
    },
    Number(process.env.PROSPECTUS_INTAKE_PORT ?? 5491),
    process.env.PROSPECTUS_INTAKE_ORIGIN ?? "http://127.0.0.1:5490",
  );
  console.log("Synthetic intake listening at http://127.0.0.1:5491; real contacts are refused.");
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => server.close());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  void main().catch(() => {
    console.error("Local intake failed to start. Check the private API and ledger configuration.");
    process.exitCode = 1;
  });
