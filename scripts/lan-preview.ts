import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { startLocalIntake } from "../server/local";
import { FileControlStore } from "../server/control-store";

const address = process.env.PROSPECTUS_LAN_ADDRESS;
if (!address) throw new Error("Set the explicit private LAN address for synthetic review.");
if (!/^192\.168\.\d{1,3}\.\d{1,3}$/.test(address)) throw new Error("A specific private LAN address is required.");
const origin = `http://${address}:5493`;
const root = resolve("local-data/lan-review/kanbus");
await mkdir(`${root}/project/issues`, { recursive: true, mode: 0o700 });
await mkdir(`${root}/project/events`, { recursive: true, mode: 0o700 });
try { await writeFile(`${root}/.kanbus.yml`, await readFile("config/prospectus.kanbus.yml"), { flag: "wx", mode: 0o600 }); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
const token = randomBytes(32).toString("hex"); // Memory only; never sent to the browser or logged.
const backend = "http://127.0.0.1:5495/api";
const apiProcess: ChildProcess = spawn(resolve(".build/kanbus-api-local"), [], { env: { ...process.env, KANBUS_BACKEND: "file", KANBUS_ROOT: root, KANBUS_NAMESPACE: "cyclotron/prospectus", KANBUS_PORT: "5495", KANBUS_LOCAL_TOKEN: token }, stdio: ["ignore", "ignore", "inherit"] });
async function privateRequest(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers); headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${backend}${path}`, { ...init, headers, signal: AbortSignal.timeout(10000) });
}
for (let attempt = 0; ; attempt++) {
  try { if ((await fetch(`${backend}/issues`)).status === 401) break; } catch { /* Starting. */ }
  if (attempt >= 80) { apiProcess.kill(); throw new Error("Loopback API failed to start."); }
  await new Promise(resolve => setTimeout(resolve, 100));
}
const intake = await startLocalIntake({
  directory: resolve("local-data/lan-review/intake"), workspace: "cyclotron/prospectus", owner: "local-member", siteId: "prospectus-web-review", formId: "demo-v1",
  identityStore: new FileControlStore(resolve("local-data/lan-review/identity-claims")),
  request: async (path, init) => { const response = await privateRequest(path, init); if (!response.ok) throw new Error("Synthetic API request failed."); return response.json(); },
}, 5494, origin);
const fonts = new Set((await readdir(".build/lan-static/fonts")).filter(name => name.endsWith(".ttf")));
function synthetic(record: any): boolean { return record?.issue?.type === "prospect" && typeof record.issue.custom?.contact_email === "string" && /^[^\s@]+@[^\s@]+\.invalid$/i.test(record.issue.custom.contact_email); }
const server = createServer(async (request, response) => {
  const send = (status: number, value: unknown) => { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(value)); };
  try {
    if (request.headers.host !== `${address}:5493`) { send(403, { message: "Use the configured LAN review URL." }); return; }
    const url = new URL(request.url ?? "/", origin);
    const method = request.method ?? "GET";
    if (method !== "GET" && request.headers.origin !== origin) { send(403, { message: "Submit from this synthetic review." }); return; }
    let body: string | undefined;
    if (method !== "GET") {
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") { send(415, { message: "JSON required." }); return; }
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 12000) { send(413, { message: "Request too large." }); return; } chunks.push(Buffer.from(chunk)); }
      body = Buffer.concat(chunks).toString("utf8");
    }
    if (url.pathname === "/intake/demo" && method === "POST") {
      const result = await fetch("http://127.0.0.1:5494/intake/demo", { method, headers: { Origin: origin, "Content-Type": "application/json" }, body, signal: AbortSignal.timeout(15000) });
      send(result.status, await result.json()); return;
    }
    if (url.pathname.startsWith("/api/")) {
      const path = url.pathname.slice(4);
      const item = /^\/issues\/([a-zA-Z0-9-]+)(\/comments)?$/.exec(path);
      const allowed = method === "GET" && (path === "/config" || path === "/issues" || item && !item[2]) || method === "PATCH" && item && !item[2] || method === "POST" && (path === "/issues" || item?.[2]);
      if (!allowed) { send(404, { message: "Unavailable in synthetic review." }); return; }
      if (item) { const current = await privateRequest(`/issues/${item[1]}`); if (!current.ok || !synthetic(await current.json())) { send(404, { message: "Synthetic prospect not found." }); return; } }
      if (method !== "GET") {
        const changes = JSON.parse(body!);
        const keys = item?.[2] ? ["text"] : method === "PATCH" ? ["status", "assignee", "custom"] : ["title", "type", "assignee", "description", "custom"];
        if (!changes || typeof changes !== "object" || Object.keys(changes).some(key => !keys.includes(key)) || !item?.[2] && !synthetic({ issue: { type: changes.type ?? "prospect", custom: changes.custom } }) || item?.[2] && (typeof changes.text !== "string" || changes.text.length > 3000)) { send(400, { message: "Synthetic .invalid prospects only; unsupported fields refused." }); return; }
      }
      const headers: Record<string,string> = { "Content-Type": "application/json" };
      for (const key of ["if-match", "x-operation-id"]) if (typeof request.headers[key] === "string") headers[key] = request.headers[key];
      if (path === "/issues") url.searchParams.set("type", "prospect");
      const result = await privateRequest(`${path}${url.search}`, { method, headers, body });
      const value = await result.json();
      if (!result.ok) { send(result.status, { message: "Synthetic workspace request could not be completed." }); return; }
      if (path !== "/config" && !(Array.isArray(value.issues) ? value.issues.every(synthetic) : synthetic(value))) { send(503, { message: "Synthetic data boundary check failed." }); return; }
      send(result.status, value); return;
    }
    const assets = new Set(await readdir(".build/lan-static/assets"));
    const asset = /^\/assets\/([^/]+)$/.exec(url.pathname);
    const font = /^\/fonts\/([^/]+)$/.exec(url.pathname);
    const file = method === "GET" && (url.pathname === "/" || url.pathname === "/request-demo") ? ".build/lan-static/index.html" : method === "GET" && asset && assets.has(asset[1]) ? `.build/lan-static/assets/${asset[1]}` : method === "GET" && font && fonts.has(font[1]) ? `.build/lan-static/fonts/${font[1]}` : null;
    if (!file) { send(404, { message: "Not found." }); return; }
    response.writeHead(200, { "Content-Type": file.endsWith(".html") ? "text/html" : file.endsWith(".css") ? "text/css" : file.endsWith(".ttf") ? "font/ttf" : "text/javascript", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'" }); response.end(await readFile(file));
  } catch { send(503, { message: "Synthetic review temporarily unavailable." }); }
});
await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(5493, address, resolve); });
console.log(`Synthetic review: ${origin}/request-demo; workspace: ${origin}/. APIs remain loopback.`);
let stopping = false;
function stop() { if (stopping) return; stopping = true; server.close(); intake.server.close(); apiProcess.kill(); }
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, stop);
apiProcess.once("exit", () => { stop(); process.exitCode = 1; });
