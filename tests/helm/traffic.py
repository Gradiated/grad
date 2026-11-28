"""Traffic through the API Service while tests/helm/smoke.sh rolls the API
pods (stdlib only; runs inside a worker pod, which the NetworkPolicy lets in).

Keep-alive and fresh-connection GETs, no retries, until the file STOP exists
(or 600 s). Prints counts; exits 1 if any request failed: a rolling update
must drain each replica (readiness first, then Connection: close) before it
stops listening.

    python traffic.py http://grad-grad-api:8787 API_KEY /tmp/stop
"""

import collections
import http.client
import json
import os
import sys
import threading
import time
from urllib.parse import urlsplit

url, key, stop = urlsplit(sys.argv[1]), sys.argv[2], sys.argv[3]
headers = {"Authorization": f"Bearer {key}"}
counts: collections.Counter[str] = collections.Counter()
lock = threading.Lock()
deadline = time.monotonic() + 600


def note(what: str) -> None:
    with lock:
        counts[what] += 1


def client(keep_alive: bool) -> None:
    conn = None
    while not os.path.exists(stop) and time.monotonic() < deadline:
        try:
            conn = conn or http.client.HTTPConnection(url.hostname, url.port, timeout=10)
            conn.request("GET", "/v1/runs?limit=1", headers=headers if keep_alive else {**headers, "Connection": "close"})
            res = conn.getresponse()
            res.read()
            note("ok" if res.status == 200 else f"http_{res.status}")
            if not keep_alive or res.getheader("connection", "").lower() == "close":
                conn.close()
                conn = None
        except Exception as error:  # noqa: BLE001 - every failure counts
            note(type(error).__name__)
            conn = None
        time.sleep(0.02)


threads = [threading.Thread(target=client, args=(i % 2 == 0,)) for i in range(6)]
for t in threads:
    t.start()
for t in threads:
    t.join()
print(json.dumps(dict(counts)))
sys.exit(0 if set(counts) == {"ok"} and counts["ok"] > 100 else 1)
