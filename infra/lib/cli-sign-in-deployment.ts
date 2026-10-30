import { readFileSync } from "node:fs";
import { TARGET_ACCOUNT, TARGET_REGION } from "./scope";

/** The cli-login broker stack's outputs: its function (invoked by the pages) and its public function URL. */
export interface CliSignInBroker {
  readonly functionArn: string;
  readonly endpoint: string;
}

const FUNCTION_ARN = new RegExp(
  `^arn:aws:lambda:${TARGET_REGION}:${TARGET_ACCOUNT}:function:[A-Za-z0-9_-]{1,64}$`,
);
const FUNCTION_URL = new RegExp(`^https://[a-z0-9]{32}\\.lambda-url\\.${TARGET_REGION}\\.on\\.aws/?$`);

const refuse = (reason: string): never => {
  throw new Error(`infra/cli-sign-in.json: ${reason}`);
};

/**
 * Activation for remote CLI sign-in (kanbus-fb0837). Enabled with `broker: null` deploys the pages and their role
 * unconfigured (every route answers 503), so the broker stack can name that role; then the broker's outputs are
 * committed here and the pages may invoke it.
 */
export function parseCliSignIn(config: unknown): { broker: CliSignInBroker | null } | null {
  if (typeof config !== "object" || config === null) return refuse("must be an object");
  const { enabled, broker, ...rest } = config as Record<string, unknown>;
  if (Object.keys(rest).length || typeof enabled !== "boolean" || !("broker" in config))
    return refuse("must contain exactly enabled (boolean) and broker");
  if (broker === null) return enabled ? { broker: null } : null;
  if (typeof broker !== "object") return refuse("broker must be null or an object");
  const { functionArn, endpoint, ...extra } = broker as Record<string, unknown>;
  if (Object.keys(extra).length) refuse("broker must contain only functionArn and endpoint");
  if (typeof functionArn !== "string" || !FUNCTION_ARN.test(functionArn))
    refuse(`broker.functionArn must be a Lambda function in ${TARGET_ACCOUNT} ${TARGET_REGION}`);
  if (typeof endpoint !== "string" || !FUNCTION_URL.test(endpoint))
    refuse(`broker.endpoint must be that function's https function URL in ${TARGET_REGION}`);
  return enabled ? { broker: { functionArn: functionArn as string, endpoint: endpoint as string } } : null;
}

export function cliSignInDeployment() {
  return parseCliSignIn(JSON.parse(readFileSync(new URL("../cli-sign-in.json", import.meta.url), "utf8")));
}
