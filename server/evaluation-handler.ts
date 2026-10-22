import { IntakeError, type IntakeService } from "./intake";
import { DEMO_ROUTE_PATH, formRoutePath, newsletterPagePath, type IntakeFormConfig } from "./intake-forms";
import type { NewsletterService } from "./newsletter";
import { PAGE_HEADERS, renderPage } from "./newsletter-pages";

export interface EvaluationEvent {
  requestContext?: { http?: { method?: string }; domainName?: string };
  rawPath?: string;
  rawQueryString?: string;
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

type SubmissionService = Pick<IntakeService, "submit" | "close">;
type Newsletter = Pick<NewsletterService, "subscribe" | "confirm" | "unsubscribe">;

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

/**
 * The public base URL for links in list emails: the API Gateway default endpoint the signup arrived
 * on. API Gateway sets domainName; only an execute-api host is accepted.
 */
export function executeApiLinkBase(event: EvaluationEvent): string | null {
  const domain = event.requestContext?.domainName ?? "";
  return /^[a-z0-9]{10}\.execute-api\.[a-z]{2}-[a-z]+-\d\.amazonaws\.com$/.test(domain)
    ? `https://${domain}`
    : null;
}

const CONFIRM_PATH = newsletterPagePath("confirm");
const UNSUBSCRIBE_PATH = newsletterPagePath("unsubscribe");
const UNCONFIRMED_SIGNUP = "The signup could not be confirmed. Retry the same receipt.";

/** A fixed submission boundary for configured form origins; no record-reading capability. */
export function createEvaluationHandler(options: {
  allowedOrigins: readonly string[];
  open: () => Promise<SubmissionService>;
  forms?: readonly IntakeFormConfig[];
  openForm?: (form: IntakeFormConfig) => Promise<SubmissionService>;
  /** Serves enabled newsletter forms and their confirm and unsubscribe pages. */
  newsletter?: () => Promise<Newsletter>;
  newsletterLinkBase?: (event: EvaluationEvent) => string | null;
  reportUnconfirmed?: (diagnostic: UnconfirmedSubmissionDiagnostic) => void;
}) {
  const reportUnconfirmed =
    options.reportUnconfirmed ?? ((diagnostic) => console.error(JSON.stringify(diagnostic)));
  const linkBase = options.newsletterLinkBase ?? executeApiLinkBase;
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
    const method = event.requestContext?.http?.method;
    // Confirm and unsubscribe pages: opened from an email (GET) or posted by the page's button or a
    // mail client's RFC 8058 one-click request (POST). The signed token is the only authority, so no
    // Origin is required, and the body is ignored.
    if (
      options.newsletter &&
      (event.rawPath === CONFIRM_PATH || event.rawPath === UNSUBSCRIBE_PATH) &&
      (method === "GET" || method === "POST")
    ) {
      const token = new URLSearchParams(event.rawQueryString ?? "").get("token") ?? "";
      const service = await options.newsletter();
      const page =
        event.rawPath === CONFIRM_PATH
          ? await service.confirm(token, method)
          : await service.unsubscribe(token, method);
      return {
        statusCode: page.status,
        headers: PAGE_HEADERS,
        body: renderPage(page, page.button ? `?token=${encodeURIComponent(token)}` : undefined),
      };
    }
    if (method !== "POST") return response(404, { message: "Not found." });
    const form = options.forms?.find((candidate) => formRoutePath(candidate) === event.rawPath);
    const served = form && (form.kind === "newsletter" ? !!options.newsletter : !!options.openForm);
    if (event.rawPath !== DEMO_ROUTE_PATH && !served) return response(404, { message: "Not found." });
    const routeOrigins = form ? form.origins : options.allowedOrigins;
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
    if (form?.kind === "newsletter") {
      try {
        const base = linkBase(event);
        if (!base) throw new IntakeError(503, UNCONFIRMED_SIGNUP);
        return response(202, await (await options.newsletter!()).subscribe(form, body, base));
      } catch (cause) {
        if (cause instanceof IntakeError) return response(cause.status, { message: cause.message });
        reportUnconfirmed(diagnoseUnconfirmedSubmission(cause));
        return response(503, { message: UNCONFIRMED_SIGNUP });
      }
    }
    const openService = () => (form ? options.openForm!(form) : options.open());
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
