import { IntakeError, type IntakeService } from "./intake";
import { DEMO_ROUTE_PATH, formRoutePath, type IntakeFormConfig } from "./intake-forms";

export interface EvaluationEvent {
  requestContext?: { http?: { method?: string } };
  rawPath?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

type SubmissionService = Pick<IntakeService, "submit" | "close">;

export interface UnconfirmedSubmissionDiagnostic {
  event: "intake-submission-unconfirmed";
  errorClass: string;
  outcome?: string;
}

export function diagnoseUnconfirmedSubmission(cause: unknown): UnconfirmedSubmissionDiagnostic {
  const errorClass = cause instanceof Error ? cause.constructor.name : typeof cause;
  const outcome = (cause as { outcome?: unknown } | null)?.outcome;
  return {
    event: "intake-submission-unconfirmed",
    errorClass,
    ...(typeof outcome === "string" ? { outcome } : {}),
  };
}

/** A fixed submission boundary for configured form origins; no record-reading capability. */
export function createEvaluationHandler(options: {
  allowedOrigins: readonly string[];
  open: () => Promise<SubmissionService>;
  forms?: readonly IntakeFormConfig[];
  openForm?: (form: IntakeFormConfig) => Promise<SubmissionService>;
  reportUnconfirmed?: (diagnostic: UnconfirmedSubmissionDiagnostic) => void;
}) {
  const reportUnconfirmed =
    options.reportUnconfirmed ?? ((diagnostic) => console.error(JSON.stringify(diagnostic)));
  return async (event: EvaluationEvent) => {
    const response = (statusCode: number, body: unknown) => ({
      statusCode,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
      body: JSON.stringify(body),
    });
    if (event.requestContext?.http?.method !== "POST") return response(404, { message: "Not found." });
    const form = options.forms?.find((candidate) => formRoutePath(candidate) === event.rawPath);
    if (event.rawPath !== DEMO_ROUTE_PATH && !(form && options.openForm))
      return response(404, { message: "Not found." });
    const routeOrigins = form ? form.origins : options.allowedOrigins;
    const openService = () => (form ? options.openForm!(form) : options.open());
    const headers = Object.fromEntries(
      Object.entries(event.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
    );
    if (!headers.origin || !routeOrigins.includes(headers.origin))
      return response(403, { message: "This form origin is not allowed." });
    if (!/^application\/json(?:\s*;|$)/i.test(headers["content-type"] ?? ""))
      return response(415, { message: "A JSON submission is required." });
    if (event.isBase64Encoded || !event.body || Buffer.byteLength(event.body) > 16384)
      return response(400, { message: "Invalid submission size or encoding." });
    let body: unknown;
    try {
      body = JSON.parse(event.body);
    } catch {
      return response(400, { message: "Invalid JSON submission." });
    }
    let service: SubmissionService | undefined;
    try {
      service = await openService();
      const receipt = await service.submit(body);
      return response(202, receipt);
    } catch (cause) {
      if (cause instanceof IntakeError) return response(cause.status, { message: cause.message });
      reportUnconfirmed(diagnoseUnconfirmedSubmission(cause));
      return response(503, { message: "The inquiry could not be confirmed. Retry the same receipt." });
    } finally {
      await service?.close().catch(() => undefined);
    }
  };
}
