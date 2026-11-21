"""urllib client for the Kimodo motion service: POST /v1/generate (npz bytes) and GET /v1/skeleton, bearer token."""
import json
import threading
import urllib.error
import urllib.request

GENERATE_TIMEOUT = 2.0  # s
SKELETON_TIMEOUT = 2.0  # s


class ServiceError(Exception):
    """reason: timeout, unreachable or http_<status>."""

    def __init__(self, reason):
        super().__init__(reason)
        self.reason = reason


class MotionClient:
    def __init__(self, timeout=GENERATE_TIMEOUT, skeleton_timeout=SKELETON_TIMEOUT):
        self.timeout, self.skeleton_timeout = timeout, skeleton_timeout
        self._skeletons = {}  # service URL -> its skeleton document
        self._lock = threading.Lock()

    def generate(self, url, token, prompt, seconds, seed=None, steps=None, constraints=None, timeout=None):
        """The npz bytes of one generated motion; constraints: the service's {root, effectors}; timeout: s, None for
        GENERATE_TIMEOUT."""
        body = {"prompt": prompt, "seconds": seconds}
        body.update({k: v for k, v in (("seed", seed), ("steps", steps), ("constraints", constraints)) if v is not None})
        return self._call(url, "/v1/generate", token, self.timeout if timeout is None else timeout, json.dumps(body).encode())

    def skeleton(self, url, token):
        """The service's skeleton document, fetched once per service URL."""
        with self._lock:
            if url not in self._skeletons:
                self._skeletons[url] = json.loads(self._call(url, "/v1/skeleton", token, self.skeleton_timeout))
            return self._skeletons[url]

    @staticmethod
    def _call(url, path, token, timeout, data=None):
        headers = {"Content-Type": "application/json"} | ({"Authorization": f"Bearer {token}"} if token else {})
        request = urllib.request.Request(url.rstrip("/") + path, data=data, method="GET" if data is None else "POST",
                                         headers=headers)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            raise ServiceError(f"http_{error.code}") from error
        except TimeoutError as error:
            raise ServiceError("timeout") from error
        except urllib.error.URLError as error:
            raise ServiceError("timeout" if isinstance(error.reason, TimeoutError) else "unreachable") from error
