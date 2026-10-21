import * as apigw from "aws-cdk-lib/aws-apigatewayv2";

export interface RouteThrottle {
  /** Route key as API Gateway expects it in RouteSettings, for example "POST /path". */
  readonly routeKey: string;
  /** The route this setting configures; the stage must be updated only after it exists. */
  readonly route: apigw.HttpRoute;
  readonly burstLimit: number;
  readonly rateLimit: number;
}

/** Default throttling for every route of a stage that has no setting of its own. */
export function throttleStageDefault(stage: apigw.IHttpStage, rateLimit: number, burstLimit: number): void {
  const cfnStage = stage.node.defaultChild as apigw.CfnStage;
  cfnStage.defaultRouteSettings = { throttlingBurstLimit: burstLimit, throttlingRateLimit: rateLimit };
}

/**
 * Sets per-route throttling on a stage and makes the stage depend on every route it names.
 * CloudFormation otherwise may update the stage before creating the route and fails with
 * "Unable to find Route by key ... within the provided RouteSettings". Always use this
 * instead of assigning `routeSettings` directly.
 */
export function throttleRoutes(stage: apigw.IHttpStage, throttles: RouteThrottle[]): void {
  const cfnStage = stage.node.defaultChild as apigw.CfnStage;
  const settings: Record<string, unknown> = { ...(cfnStage.routeSettings as object) };
  for (const throttle of throttles) {
    settings[throttle.routeKey] = {
      ThrottlingBurstLimit: throttle.burstLimit,
      ThrottlingRateLimit: throttle.rateLimit,
    };
    cfnStage.addDependency(throttle.route.node.defaultChild as apigw.CfnRoute);
  }
  cfnStage.routeSettings = settings;
}
