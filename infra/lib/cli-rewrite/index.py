"""CloudFormation custom resource: keep one proxy rewrite at the top of an Amplify app's rules.

Only the rule whose source is ResourceProperties.Source is added, replaced or removed; every other rule is kept in
order, so hand-applied rules (infra/hosting-settings.json) survive. Inlined by infra/lib/cli-sign-in.ts.
"""

import json
import urllib.request

PHYSICAL_ID = "prospectus-cli-rewrite"


def desired_rules(rules, request, properties, old_properties):
    owned = {properties["Source"], (old_properties or {}).get("Source")}
    others = [rule for rule in rules if rule.get("source") not in owned]
    if request == "Delete":
        return others
    rule = {"source": properties["Source"], "target": properties["Target"], "status": "200"}
    return [rule, *others]


def apply(event, amplify):
    properties = event["ResourceProperties"]
    app_id = properties["AppId"]
    rules = amplify.get_app(appId=app_id)["app"].get("customRules", [])
    desired = desired_rules(rules, event["RequestType"], properties, event.get("OldResourceProperties"))
    if desired != rules:
        amplify.update_app(appId=app_id, customRules=desired)


def _put(url, body):
    request = urllib.request.Request(url, data=body, method="PUT", headers={"Content-Type": ""})
    with urllib.request.urlopen(request, timeout=10):
        pass


def handler(event, context, amplify=None, put=_put):
    status, reason = "SUCCESS", "applied"
    try:
        if amplify is None:
            import boto3

            amplify = boto3.client("amplify")
        apply(event, amplify)
    except Exception as error:  # report every failure so CloudFormation never waits for a timeout
        status, reason = "FAILED", f"{type(error).__name__}: {error}"[:300]
    body = {
        "Status": status,
        "Reason": reason,
        "PhysicalResourceId": PHYSICAL_ID,
        "StackId": event["StackId"],
        "RequestId": event["RequestId"],
        "LogicalResourceId": event["LogicalResourceId"],
    }
    put(event["ResponseURL"], json.dumps(body).encode())
