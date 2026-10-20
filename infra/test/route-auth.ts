/**
 * API Gateway rejects AuthorizationScopes on a route whose AuthorizationType is not JWT or
 * COGNITO_USER_POOLS ("Authorization Scopes are only valid for COGNITO_USER_POOLS and JWT").
 * A NONE route inherits the API's defaultAuthorizationScopes unless it passes an empty list.
 * Returns the logical IDs of routes in a synthesized template that violate this.
 */
export function unscopableRoutesWithScopes(synth: any): string[] {
  return Object.entries(synth.Resources as Record<string, any>)
    .filter(
      ([, resource]) =>
        resource.Type === "AWS::ApiGatewayV2::Route" &&
        ["NONE", undefined].includes(resource.Properties.AuthorizationType) &&
        (resource.Properties.AuthorizationScopes ?? []).length > 0,
    )
    .map(([id]) => id);
}
