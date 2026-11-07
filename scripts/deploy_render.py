"""Deploy the exact checked Git commit and wait until Render reports it live."""

import json
import os
import time
from urllib.error import HTTPError
from urllib.request import Request, urlopen


def main():
    service = os.environ["RENDER_SERVICE_ID"]
    token = os.environ["RENDER_API_KEY"]
    commit = os.environ["GITHUB_SHA"]
    base = f"https://api.render.com/v1/services/{service}/deploys"

    def call(url, payload=None):
        request = Request(
            url,
            data=None if payload is None else json.dumps(payload).encode(),
            headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        )
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as exc:
            # Never echo response bodies, request headers or the API key into CI logs.
            raise RuntimeError(f"Render API returned HTTP {exc.code}") from None

    deploy = call(base, {"commitId": commit, "clearCache": "do_not_clear"})
    deploy_id = deploy["id"]
    print(f"Waiting for Render deployment {deploy_id} of {commit}", flush=True)
    deadline = time.monotonic() + 1800
    previous = None
    while time.monotonic() < deadline:
        status = call(base + "/" + deploy_id)["status"]
        if status != previous:
            print("Render status:", status, flush=True)
            previous = status
        if status == "live":
            return
        if status in {
            "build_failed",
            "update_failed",
            "canceled",
            "deactivated",
            "pre_deploy_failed",
        }:
            raise RuntimeError("Render deployment did not go live: " + status)
        time.sleep(10)
    raise RuntimeError("Timed out waiting for the Render deployment")


if __name__ == "__main__":
    main()
