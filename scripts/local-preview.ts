import { randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { KANBUS_API_PATH, KANBUS_PROJECT, KANBUS_TENANT } from "../src/board";

const root = resolve("local-data/review/kanbus");
await mkdir(`${root}/project/issues`, { recursive: true, mode: 0o700 });
await mkdir(`${root}/project/events`, { recursive: true, mode: 0o700 });
try {
  await writeFile(`${root}/.kanbus.yml`, await readFile("config/prospectus.kanbus.yml"), {
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
}
const token = randomBytes(32).toString("hex");
await writeFile("local-data/review-token.txt", token, { mode: 0o600 });
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  KANBUS_BACKEND: "file",
  KANBUS_ROOT: root,
  KANBUS_TENANT,
  KANBUS_PROJECT,
  KANBUS_PORT: "5492",
  KANBUS_LOCAL_TOKEN: token,
  VITE_KANBUS_API_URL: "",
  PROSPECTUS_LOCAL_API_URL: `http://127.0.0.1:5492${KANBUS_API_PATH}`,
  PROSPECTUS_LOCAL_API_ORIGIN: "http://127.0.0.1:5492",
  PROSPECTUS_INTAKE_LEDGER: resolve("local-data/review/intake"),
  PROSPECTUS_IDENTITY_DIRECTORY: resolve("local-data/review/identity-claims"),
};
for (const key of Object.keys(environment)) if (key.startsWith("VITE_COGNITO_")) delete environment[key];
const children: ChildProcess[] = [];
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  for (const child of [...children].reverse()) child.kill("SIGTERM");
}
function run(command: string, args: string[]) {
  const child = spawn(command, args, { env: environment, stdio: ["ignore", "inherit", "inherit"] });
  children.push(child);
  child.once("error", () => {
    console.error("A review service failed to start.");
    stop();
    process.exitCode = 1;
  });
  child.once("exit", (code) => {
    if (!stopping) {
      process.exitCode = code ?? 1;
      stop();
    }
  });
  return child;
}
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
process.once("exit", stop);
async function ready(url: string, expected: number) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (stopping) throw new Error("Review service stopped.");
    try {
      if ((await fetch(url)).status === expected) return;
    } catch {
      /* Startup may not yet have bound its port. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Review service did not become ready.");
}
try {
  run(resolve(process.env.KANBUS_API_BINARY ?? ".build/target/release/kanbus-api-local"), []);
  await ready(`http://127.0.0.1:5492${KANBUS_API_PATH}/issues`, 401);
  run(process.execPath, ["--import", "tsx", "server/local.ts"]);
  await ready("http://127.0.0.1:5491/", 404);
  run(process.execPath, [
    "node_modules/vite/bin/vite.js",
    "--host",
    "127.0.0.1",
    "--port",
    "5490",
    "--strictPort",
  ]);
  await ready("http://127.0.0.1:5490/request-demo", 200);
  console.log("Review form: http://127.0.0.1:5490/request-demo (Mac only; synthetic .invalid contacts)");
  console.log(
    "Private review workspace: http://127.0.0.1:5490/; local token is in ignored local-data/review-token.txt.",
  );
} catch (error) {
  console.error((error as Error).message);
  stop();
  process.exitCode = 1;
}
