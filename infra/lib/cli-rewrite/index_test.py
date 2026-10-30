import json

import index

SPA = {"source": "</^[^.]+$/>", "target": "/index.html", "status": "200"}
OTHER = {"source": "/old", "target": "/new", "status": "301"}
SOURCE = "/cli/<*>"
TARGET = "https://abc123.execute-api.us-east-1.amazonaws.com/cli/<*>"
CLI = {"source": SOURCE, "target": TARGET, "status": "200"}


class FakeAmplify:
    def __init__(self, rules, fail=None):
        self.rules, self.fail, self.updates = list(rules), fail, []

    def get_app(self, appId):
        assert appId == "d15sc1sptohtqb"
        if self.fail:
            raise self.fail
        return {"app": {"customRules": list(self.rules)}}

    def update_app(self, appId, customRules):
        assert appId == "d15sc1sptohtqb"
        self.updates.append(customRules)
        self.rules = customRules


def event(request, target=TARGET, old=None):
    return {
        "RequestType": request,
        "ResourceProperties": {"AppId": "d15sc1sptohtqb", "Source": SOURCE, "Target": target},
        **({"OldResourceProperties": old} if old else {}),
        "ResponseURL": "https://cloudformation-custom-resource-response.example/response",
        "StackId": "stack",
        "RequestId": "request",
        "LogicalResourceId": "Rewrite",
    }


def run(request_event, amplify):
    sent = []
    index.handler(request_event, None, amplify=amplify, put=lambda url, body: sent.append((url, json.loads(body))))
    assert len(sent) == 1
    return sent[0][1]


def test_create_puts_the_rule_first_and_keeps_every_other_rule_in_order():
    amplify = FakeAmplify([OTHER, SPA])
    response = run(event("Create"), amplify)
    assert response["Status"] == "SUCCESS"
    assert response["PhysicalResourceId"] == "prospectus-cli-rewrite"
    assert amplify.rules == [CLI, OTHER, SPA]


def test_an_unchanged_rule_is_not_rewritten():
    amplify = FakeAmplify([CLI, SPA])
    run(event("Update", old=event("Create")["ResourceProperties"]), amplify)
    assert amplify.updates == []


def test_update_replaces_only_the_owned_rule():
    stale = {"source": SOURCE, "target": "https://old.execute-api.us-east-1.amazonaws.com/cli/<*>", "status": "200"}
    amplify = FakeAmplify([SPA, stale])
    run(event("Update", old={"AppId": "d15sc1sptohtqb", "Source": SOURCE, "Target": stale["target"]}), amplify)
    assert amplify.rules == [CLI, SPA]


def test_a_changed_source_drops_the_old_rule():
    old = {"source": "/cli-old/<*>", "target": TARGET, "status": "200"}
    amplify = FakeAmplify([old, SPA])
    run(event("Update", old={"AppId": "d15sc1sptohtqb", "Source": "/cli-old/<*>", "Target": TARGET}), amplify)
    assert amplify.rules == [CLI, SPA]


def test_delete_removes_only_the_owned_rule():
    amplify = FakeAmplify([CLI, OTHER, SPA])
    assert run(event("Delete"), amplify)["Status"] == "SUCCESS"
    assert amplify.rules == [OTHER, SPA]


def test_delete_without_the_rule_changes_nothing():
    amplify = FakeAmplify([SPA])
    assert run(event("Delete"), amplify)["Status"] == "SUCCESS"
    assert amplify.updates == []


def test_a_failure_is_reported_to_cloudformation():
    amplify = FakeAmplify([SPA], fail=RuntimeError("AccessDenied"))
    response = run(event("Create"), amplify)
    assert response["Status"] == "FAILED"
    assert "AccessDenied" in response["Reason"]
    assert amplify.updates == []
