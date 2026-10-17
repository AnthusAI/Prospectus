import { spawn } from "node:child_process";
import {
  ControlConflict,
  type ConditionalControlStore,
  type ControlCondition,
  type ControlObject,
} from "./control-store";

export interface ControlRequest {
  version: 1;
  workspace: string;
  operation: "get" | "put";
  path: string;
  bytes?: string;
  condition?: ControlCondition;
}
export type ControlInvoker = (request: ControlRequest) => Promise<unknown>;
export class ControlTransportError extends Error {
  constructor(
    public outcome: "uncertain" | "unavailable" | "unauthorized" | "invalid",
    message: string,
  ) {
    super(message);
  }
}
const validPath = (path: string) => /^intake-(identities|receipts)\/[a-f0-9]{64}\.json$/.test(path);
const validWorkspace = (workspace: string) =>
  /^[a-z0-9][a-z0-9_.-]{0,127}\/[a-z0-9][a-z0-9_.-]{0,127}$/.test(workspace) &&
  !workspace.startsWith("_virtuus/");

export class VirtuusS3ControlStore implements ConditionalControlStore {
  constructor(
    private workspace: string,
    private invoke: ControlInvoker,
  ) {
    if (!validWorkspace(workspace))
      throw new ControlTransportError("unauthorized", "Invalid configured workspace.");
  }
  private async request(request: ControlRequest): Promise<ControlObject | null> {
    if (!validPath(request.path)) throw new ControlTransportError("invalid", "Invalid control path.");
    const response = (await this.invoke(request)) as {
      version?: number;
      workspace?: string;
      path?: string;
      status?: string;
      object?: ControlObject;
    };
    if (
      !response ||
      response.version !== 1 ||
      response.workspace !== this.workspace ||
      response.path !== request.path
    )
      throw new ControlTransportError("uncertain", "Control response correlation failed.");
    if (response.status === "conflict") throw new ControlConflict("Control revision changed.");
    if (response.status === "missing" && request.operation === "get") return null;
    if (response.status !== "ok") {
      const outcome = ["unavailable", "unauthorized", "invalid"].includes(response.status ?? "")
        ? (response.status as "unavailable" | "unauthorized" | "invalid")
        : "uncertain";
      throw new ControlTransportError(outcome, "Scoped control operation could not complete.");
    }
    if (
      !response.object ||
      typeof response.object.bytes !== "string" ||
      Buffer.byteLength(response.object.bytes) > 32768 ||
      typeof response.object.revision !== "string" ||
      !response.object.revision ||
      response.object.revision.length > 256
    )
      throw new ControlTransportError("uncertain", "Invalid control response object.");
    return response.object;
  }
  getControl(path: string) {
    return this.request({ version: 1, workspace: this.workspace, operation: "get", path });
  }
  async putControl(path: string, bytes: string, condition: ControlCondition): Promise<ControlObject> {
    if (
      Buffer.byteLength(bytes) > 32768 ||
      ("absent" in condition
        ? condition.absent !== true
        : !condition.revision || condition.revision.length > 256)
    )
      throw new ControlTransportError("invalid", "Invalid conditional control write.");
    const object = await this.request({
      version: 1,
      workspace: this.workspace,
      operation: "put",
      path,
      bytes,
      condition,
    });
    if (!object) throw new ControlTransportError("uncertain", "Conditional write has no stored object.");
    return object;
  }
}

export interface S3TransportOptions {
  executable: string;
  workspace: string;
  bucket: string;
  region: string;
  enabled: boolean;
  timeoutMs?: number;
}
export function createStdioS3Invoker(options: S3TransportOptions): ControlInvoker {
  if (
    !options.enabled ||
    !options.executable.startsWith("/") ||
    !validWorkspace(options.workspace) ||
    !options.bucket ||
    !options.region
  )
    throw new ControlTransportError(
      "unauthorized",
      "An explicitly enabled, fixed S3 transport configuration is required.",
    );
  return (request) =>
    new Promise((resolve, reject) => {
      if (request.workspace !== options.workspace) {
        reject(new ControlTransportError("unauthorized", "Workspace routing denied."));
        return;
      }
      const payload = JSON.stringify(request);
      if (Buffer.byteLength(payload) > 65536) {
        reject(new ControlTransportError("invalid", "Control request exceeds the transport bound."));
        return;
      }
      const child = spawn(options.executable, [], {
        env: {
          ...process.env,
          PROSPECTUS_CONTROL_S3_ENABLED: "true",
          PROSPECTUS_CONTROL_WORKSPACE: options.workspace,
          PROSPECTUS_CONTROL_BUCKET: options.bucket,
          PROSPECTUS_CONTROL_REGION: options.region,
        },
        stdio: ["pipe", "pipe", "ignore"],
      });
      const output: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      const finish = (error?: Error, result?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error && child.pid && child.exitCode === null) child.kill("SIGKILL");
        error ? reject(error) : resolve(result);
      };
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        finish(new ControlTransportError("uncertain", "Control bridge response timed out."));
      }, options.timeoutMs ?? 15000);
      child.on("error", () =>
        finish(new ControlTransportError("unavailable", "Control bridge could not start.")),
      );
      child.stdin.on("error", () =>
        finish(new ControlTransportError("uncertain", "Control request delivery failed.")),
      );
      child.stdout.on("data", (data: Buffer) => {
        output.push(data);
        outputBytes += data.byteLength;
        if (outputBytes > 65536) {
          child.kill("SIGKILL");
          finish(new ControlTransportError("uncertain", "Control bridge response exceeds the bound."));
        }
      });
      child.on("close", (code) => {
        if (code !== 0) {
          finish(
            new ControlTransportError("uncertain", "Control bridge exited without an accepted response."),
          );
          return;
        }
        try {
          finish(
            undefined,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(output))),
          );
        } catch {
          finish(new ControlTransportError("uncertain", "Control bridge response was lost or invalid."));
        }
      });
      child.stdin.end(payload);
    });
}

export function createScopedS3ControlStore(options: S3TransportOptions) {
  return new VirtuusS3ControlStore(options.workspace, createStdioS3Invoker(options));
}
