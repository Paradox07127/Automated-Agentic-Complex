"""App-owned Sign in with ChatGPT registrations. Tokens never leave agentd's protected storage."""
import base64
import contextlib
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import secrets
import threading
import time
from urllib.parse import parse_qs, urlencode, urlparse
import uuid
import webbrowser

import httpx

from fsutil import atomic_write_json
from infra.secrets import ModelError
from infra.platform import lock_file, unlock_file
from infra.tokens import ensure_state_dir, read_token, secret_fd

ISSUER = "https://auth.openai.com"
RESOURCE = "https://api.openai.com/v1"
SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct"


def read_json(path, default):
    try:
        raw = read_token(path)
    except FileNotFoundError:
        return default
    except (OSError, SystemExit) as error:
        raise ModelError("credential_permissions") from error
    return json.loads(raw)


class ChatGPTAuth:
    def __init__(self, directory, secrets):
        self.secrets = secrets
        self.path = Path(directory) / "chatgpt-auth.json"
        self.lock = threading.RLock()
        self.pending = None
        self.error = None
        self.listener = None
        fresh = {"host_id": "urn:uuid:" + str(uuid.uuid4()), "active": None, "profiles": {}}
        try:
            self.data = fresh
            with self._storage():
                self._save()  # persist the host before first authorization
        except (ModelError, ValueError) as error:
            # Stay signed out; agentd keeps running and later sign-in calls raise per request.
            self.data = fresh
            self.error = str(error) if isinstance(error, ModelError) else "settings_unreadable"

    @contextlib.contextmanager
    def _storage(self):
        # Serialize rotating refresh tokens across agentd processes sharing this directory.
        try:
            fd = secret_fd(str(self.path) + ".lock", os.O_RDWR | os.O_CREAT)
        except (OSError, SystemExit) as error:
            raise ModelError("credential_permissions") from error
        try:
            lock_file(fd)
            self.data = read_json(self.path, self.data)
            fields = ("client_id", "label", "subject", "issuer", "email", "expires_at", "scopes")
            self.data["profiles"] = {key: {k: p[k] for k in fields if k in p}
                                     for key, p in self.data["profiles"].items()}
            yield
        finally:
            unlock_file(fd)
            os.close(fd)

    def _save(self):
        ensure_state_dir(self.path.parent)
        atomic_write_json(self.path, self.data, ensure_ascii=False)

    def state(self):
        with self.lock:
            profiles = []
            for key, profile in self.data["profiles"].items():
                connected = "expires_at" in profile and bool(self._credentials(key).get("access_token"))
                profiles.append({"id": key, "label": profile["label"], "email": profile.get("email", ""),
                                 "connected": connected,
                                 "sharing": connected and "chatgpt.tokens.use.direct" in profile.get("scopes", [])})
            return {"active": self.data["active"], "pending": self.pending is not None,
                    "error": self.error, "profiles": profiles}

    def select(self, profile_id):
        with self.lock, self._storage():
            if profile_id not in self.data["profiles"]:
                raise ModelError("unknown_profile")
            self.data["active"] = profile_id
            self.error = None
            self._save()

    def start(self, profile_id=None):
        with self.lock:
            if self.pending:
                raise ModelError("sign_in_pending")
            if profile_id and profile_id not in self.data["profiles"]:
                raise ModelError("unknown_profile")
            profile_id = profile_id or str(uuid.uuid4())
            profile = self.data["profiles"].get(profile_id, {})
            credentials = self._credentials(profile_id) if profile else {}
            auth = self

            class Callback(BaseHTTPRequestHandler):
                def log_message(self, *_):
                    pass  # callback queries contain credentials

                def do_GET(self):
                    if urlparse(self.path).path != "/auth/callback":
                        self.send_error(404)
                        return
                    ok = auth.finish(parse_qs(urlparse(self.path).query))
                    body = ("Sign-in complete. Return to Agentic Complex." if ok else
                            "Sign-in could not be completed. Return to Agentic Complex settings.").encode()
                    self.send_response(200 if ok else 400)
                    self.send_header("Content-Type", "text/plain; charset=utf-8")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)

            self.listener = ThreadingHTTPServer(("127.0.0.1", 0), Callback)
            self.listener.daemon_threads = True
            redirect = f"http://127.0.0.1:{self.listener.server_port}/auth/callback"
            state, nonce, verifier = (secrets.token_urlsafe(32) for _ in range(3))
            self.pending = {"id": profile_id, "state": state, "nonce": nonce, "verifier": verifier,
                            "redirect": redirect, "client_id": profile.get("client_id"), "expires": time.time() + 180}
            self.error = None
            params = {"client_id": profile.get("client_id", "dynamic_agent_client"),
                      "ext_agent_host_id": self.data["host_id"], "response_type": "code", "redirect_uri": redirect,
                      "scope": SCOPE, "resource": RESOURCE, "state": state, "nonce": nonce,
                      "code_challenge_method": "S256",
                      "code_challenge": base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")}
            if not profile.get("client_id"):
                params["agent_name_hint"] = "Agentic Complex"
            if credentials.get("id_token"):
                params["id_token_hint"] = credentials["id_token"]
            if profile.get("email"):
                params["login_hint"] = profile["email"]
            listener = self.listener
            threading.Thread(target=listener.serve_forever, daemon=True).start()
            timer = threading.Timer(180, self._expire, args=(state,))
            timer.daemon = True
            timer.start()
            if not webbrowser.open(ISSUER + "/api/accounts/authorize?" + urlencode(params)):
                self.cancel()
                raise ModelError("browser_unavailable")
            return self.state()

    def _expire(self, state):
        with self.lock:
            if self.pending and self.pending["state"] == state:
                self.error = "sign_in_expired"
                self.cancel()

    def cancel(self):
        with self.lock:
            self.pending = None
            listener, self.listener = self.listener, None
            if listener:
                def close():
                    listener.shutdown()
                    listener.server_close()
                threading.Thread(target=close, daemon=True).start()

    @staticmethod
    def _token(form):
        try:
            response = httpx.post(ISSUER + "/api/accounts/oauth/token", data=form, timeout=25)
            if response.status_code != 200:
                raise ModelError("sign_in_required" if response.status_code in (400, 401) else "auth_unavailable")
            return response.json()
        except (httpx.HTTPError, ValueError):
            raise ModelError("auth_unavailable") from None

    @staticmethod
    def _identity(encoded, client_id, nonce):
        import jwt
        # Fixed trusted discovery URL; never trust an issuer or JWKS URL from the received token.
        discovery = httpx.get(ISSUER + "/.well-known/openid-configuration", timeout=15).json()
        jwks = discovery["jwks_uri"]
        if not jwks.startswith(ISSUER + "/") or discovery["issuer"] != ISSUER:
            raise ModelError("invalid_identity")
        key = jwt.PyJWKClient(jwks).get_signing_key_from_jwt(encoded)
        claims = jwt.decode(encoded, key.key, algorithms=["RS256"], audience=client_id, issuer=ISSUER,
                            options={"require": ["exp", "iss", "aud", "sub", "nonce"]})
        if not hmac.compare_digest(claims["nonce"], nonce):
            raise ModelError("invalid_identity")
        return claims

    def finish(self, query):
        with self.lock, self._storage():
            attempt = self.pending
            if not attempt or not hmac.compare_digest(query.get("state", [""])[0], attempt["state"]):
                return False  # an unrelated callback must not consume the pending attempt
            try:
                if attempt["expires"] < time.time():
                    raise ModelError("sign_in_expired")
                if query.get("error"):
                    raise ModelError("sign_in_denied")
                client_id = query.get("client_id", [attempt["client_id"]])[0]
                if not client_id or client_id == "dynamic_agent_client" or (
                        attempt["client_id"] and client_id != attempt["client_id"]):
                    raise ModelError("invalid_registration")
                previous = self.data["profiles"].get(attempt["id"], {})
                profile = {**previous, "client_id": client_id,
                           "label": previous.get("label", f"连接 {len(self.data['profiles']) + 1}")}
                self.data["profiles"][attempt["id"]] = profile
                self._save()  # retain issued registration even if code exchange fails
                code = query.get("code", [""])[0]
                if not code:
                    raise ModelError("invalid_registration")
                tokens = self._token({"grant_type": "authorization_code", "client_id": client_id, "code": code,
                                      "code_verifier": attempt["verifier"], "redirect_uri": attempt["redirect"],
                                      "resource": RESOURCE})
                identity = self._identity(tokens["id_token"], client_id, attempt["nonce"])
                if previous.get("subject") and (identity["sub"] != previous["subject"] or identity["iss"] != previous["issuer"]):
                    raise ModelError("account_mismatch")
                updated = dict(profile)
                self._store_tokens(attempt["id"], updated, tokens, self._credentials(attempt["id"]))
                updated.update(subject=identity["sub"], issuer=identity["iss"], email=identity.get("email", ""))
                profile.update(updated)
                self.data["active"] = attempt["id"]
                self._save()
                self.error = None
                return True
            except Exception as error:
                self.error = str(error) if isinstance(error, ModelError) else "invalid_identity"
                return False
            finally:
                self.cancel()

    def _credentials(self, profile_id):
        raw = self.secrets.get("chatgpt-" + profile_id)
        return json.loads(raw) if raw is not None else {}

    def _store_tokens(self, profile_id, profile, tokens, previous):
        if not tokens.get("access_token") or str(tokens.get("token_type", "")).lower() != "bearer":
            raise ModelError("invalid_token_response")
        profile.update(scopes=tokens.get("scope", " ".join(profile.get("scopes", []))).split(),
                       expires_at=time.time() + float(tokens["expires_in"]))
        credentials = {key: tokens.get(key, previous.get(key)) for key in ("access_token", "refresh_token", "id_token")}
        self.secrets.put("chatgpt-" + profile_id, json.dumps(credentials).encode())
        return credentials

    def access_token(self):
        with self.lock, self._storage():
            profile = self.data["profiles"].get(self.data["active"], {})
            credentials = self._credentials(self.data["active"]) if profile else {}
            if not credentials.get("access_token"):
                raise ModelError("sign_in_required")
            if "chatgpt.tokens.use.direct" not in profile.get("scopes", []):
                raise ModelError("plan_usage_not_enabled")
            if profile["expires_at"] <= time.time() + 60:
                if not credentials.get("refresh_token"):
                    raise ModelError("sign_in_required")
                tokens = self._token({"grant_type": "refresh_token", "client_id": profile["client_id"],
                                      "refresh_token": credentials["refresh_token"], "resource": RESOURCE})
                updated = dict(profile)
                credentials = self._store_tokens(self.data["active"], updated, tokens, credentials)
                profile.update(updated)
                self._save()
                if "chatgpt.tokens.use.direct" not in profile["scopes"]:
                    raise ModelError("plan_usage_not_enabled")
            return credentials["access_token"]

    def logout(self, profile_id):
        with self.lock, self._storage():
            if self.pending:
                raise ModelError("sign_in_pending")
            profile = self.data["profiles"].get(profile_id)
            if profile is None:
                raise ModelError("unknown_profile")
            credentials = self._credentials(profile_id)
            revoked = not credentials.get("refresh_token")
            if not revoked:
                try:
                    discovery = httpx.get(ISSUER + "/.well-known/openid-configuration", timeout=15).json()
                    url = discovery["revocation_endpoint"]
                    if not url.startswith(ISSUER + "/"):
                        raise ModelError("invalid_revocation_endpoint")
                    revoked = httpx.post(url, data={"token": credentials["refresh_token"], "token_type_hint": "refresh_token",
                                                    "client_id": profile["client_id"]}, timeout=15).status_code == 200
                except Exception:
                    pass
            self.secrets.delete("chatgpt-" + profile_id)
            for name in ("expires_at", "scopes"):
                profile.pop(name, None)
            self.error = None
            self._save()
            return {"revoked": revoked}
