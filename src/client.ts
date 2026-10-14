import type { KanbanConfig, TaskDetailIssue } from "@kanbus/ui";

export type Issue = TaskDetailIssue & { custom?: Record<string, unknown> };
export interface IssueRecord { issue: Issue; revision: string; catalog_pending?: boolean }
export interface Configuration extends KanbanConfig { actor_id: string; initial_status: string; types: string[] }
export interface Query {
  type?: string; status?: string; assignee?: string; label?: string; parent?: string; search?: string;
  fields?: Array<{ field: string; operator: "eq" | "lt" | "lte" | "gt" | "gte"; value: string | number | boolean }>;
  cursor?: string; limit?: number;
}
export interface IssuePage { issues: IssueRecord[]; next_cursor: string | null }

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export class KanbusClient {
  constructor(private base: string, private token: () => string | null, private fetcher: typeof fetch = (input, options) => fetch(input, options)) {}

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = this.token();
    if (!token) throw new ApiError(401, "Sign in to access this workspace.");
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    if (options.body) headers.set("Content-Type", "application/json");
    const response = await this.fetcher(`${this.base}${path}`, { ...options, headers, cache: "no-store" });
    const result = await response.json().catch(() => ({})) as { message?: string; error?: string };
    if (!response.ok) throw new ApiError(response.status, result.message ?? result.error ?? `Request failed (${response.status}).`);
    return result as T;
  }

  config(): Promise<Configuration> { return this.request("/config"); }
  issues(query: Query = {}): Promise<IssuePage> {
    const parameters = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== "") parameters.set(key, key === "fields" ? JSON.stringify(value) : String(value));
    }
    return this.request(`/issues?${parameters}`);
  }
  issue(id: string): Promise<IssueRecord> { return this.request(`/issues/${encodeURIComponent(id)}`); }
  create(issue: Partial<Issue>): Promise<IssueRecord> {
    return this.request("/issues", { method: "POST", headers: { "X-Operation-Id": crypto.randomUUID() }, body: JSON.stringify(issue) });
  }
  update(id: string, revision: string, changes: Partial<Issue>): Promise<IssueRecord> {
    return this.request(`/issues/${encodeURIComponent(id)}`, { method: "PATCH", headers: { "If-Match": revision, "X-Operation-Id": crypto.randomUUID() }, body: JSON.stringify(changes) });
  }
  comment(id: string, revision: string, text: string): Promise<IssueRecord> {
    return this.request(`/issues/${encodeURIComponent(id)}/comments`, { method: "POST", headers: { "If-Match": revision, "X-Operation-Id": crypto.randomUUID() }, body: JSON.stringify({ text }) });
  }
}
