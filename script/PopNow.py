#!/usr/bin/env python3
"""PopNow for DaVinci Resolve: the script version (Workspace > Scripts > PopNow).

A smaller sibling of the Workflow Integration plugin, for Resolve editions that can run scripts but
not Workflow Integrations:
  - Edit image: change the frame under the playhead, the result lands on a new video track;
  - Image to video: turn that frame into a video clip;
  - Video to audio: make sound effects for the clip under the playhead, on a new audio track;
  - Balance: your PopNow credits.

Sign-in is your PopNow account in the browser (OAuth with PKCE and a loopback address on
127.0.0.1); the tokens are kept in a file only you can read (0600), shared with the plugin. Every
paid run shows its price in credits first and only starts when you click it, with that price as the
limit. Python 3.6+ standard library only.

The window uses Resolve's UIManager when it is available (Studio, and the free edition before 19.1).
Where it isn't, the same controls open as a page in your browser served from 127.0.0.1.
"""

import base64
import hashlib
import json
import os
import queue
import re
import secrets
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

VERSION = "0.1.0"
DEFAULT_MCP_URL = "https://api.popnow.ai/mcp"
SCOPES = "generate read"
CLIENT_NAME = "PopNow for DaVinci Resolve (script)"
PRICING_URL = "https://popnow.ai/pricing"
LIBRARY_URL = "https://popnow.ai/assets"
PROTOCOL_VERSION = "2025-06-18"
LOGIN_TIMEOUT = 300
QUOTE_TTL = 600


class PopNowError(Exception):
    pass


class SignInRequired(PopNowError):
    def __init__(self, message="Sign in to PopNow first."):
        PopNowError.__init__(self, message)


class StoppedWaiting(PopNowError):
    def __init__(self, job_id):
        PopNowError.__init__(self, "Stopped waiting. PopNow keeps making it and saves it to your library.")
        self.job_id = job_id


# ---------------------------------------------------------------------------------------------
# HTTP


class Response(object):
    def __init__(self, status, headers, body):
        self.status = status
        self.headers = headers
        self.body = body

    def json(self):
        try:
            return json.loads(self.body.decode("utf-8") or "{}")
        except ValueError:
            return {}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def http(method, url, headers=None, body=None, timeout=30):
    """One HTTP request. Returns Response for every status; raises only on network errors."""
    request = urllib.request.Request(url, data=body, method=method, headers=headers or {})
    try:
        with _OPENER.open(request, timeout=timeout) as reply:
            return Response(reply.status, {k.lower(): v for k, v in reply.headers.items()}, reply.read())
    except urllib.error.HTTPError as error:
        return Response(error.code, {k.lower(): v for k, v in (error.headers or {}).items()}, error.read() or b"")


def _is_loopback(parsed):
    return parsed.hostname in ("127.0.0.1", "localhost", "::1")


def require_secure(raw, what):
    """Only https, except a server on this computer (for local testing)."""
    parsed = urllib.parse.urlparse(raw)
    if parsed.scheme != "https" and not (parsed.scheme == "http" and _is_loopback(parsed)):
        raise PopNowError("%s must use https: %s://%s" % (what, parsed.scheme, parsed.netloc))
    return parsed


# ---------------------------------------------------------------------------------------------
# Sign-in (ported from popnow-cli src/account/oauth.ts)


def _get_json(url):
    reply = http("GET", url, {"accept": "application/json"})
    if reply.status != 200:
        raise PopNowError("%s answered %d" % (url, reply.status))
    return reply.json()


def discover(mcp_url):
    mcp = require_secure(mcp_url, "the PopNow server")
    origin = "%s://%s" % (mcp.scheme, mcp.netloc)
    path = "" if mcp.path in ("", "/") else mcp.path
    resource = _get_json(origin + "/.well-known/oauth-protected-resource" + path)
    servers = resource.get("authorization_servers")
    issuer = servers[0] if isinstance(servers, list) and servers and isinstance(servers[0], str) else origin
    require_secure(issuer, "the sign-in server")
    meta = _get_json(issuer.rstrip("/") + "/.well-known/oauth-authorization-server")
    declared = meta.get("issuer")
    if not isinstance(declared, str) or declared.rstrip("/") != issuer.rstrip("/"):
        raise PopNowError("the sign-in server's metadata does not match it (issuer mismatch)")
    out = {"issuer": declared}
    for key in ("authorization_endpoint", "token_endpoint", "registration_endpoint"):
        value = meta.get(key)
        if not isinstance(value, str) or not value:
            raise PopNowError("the sign-in server did not return %s" % key.replace("_", " "))
        require_secure(value, "the sign-in server")
        out[key] = value
    if isinstance(meta.get("revocation_endpoint"), str):
        require_secure(meta["revocation_endpoint"], "the sign-in server")
        out["revocation_endpoint"] = meta["revocation_endpoint"]
    return out


def register_client(server, redirect_uri):
    body = json.dumps({
        "client_name": CLIENT_NAME,
        "redirect_uris": [redirect_uri],
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": "none",
        "scope": SCOPES,
    }).encode("utf-8")
    reply = http("POST", server["registration_endpoint"], {"content-type": "application/json", "accept": "application/json"}, body)
    if reply.status not in (200, 201):
        raise PopNowError("client registration failed (%d)" % reply.status)
    client_id = reply.json().get("client_id")
    if not isinstance(client_id, str) or not client_id:
        raise PopNowError("the sign-in server did not return a client id")
    return client_id


def pkce_pair():
    verifier = base64.urlsafe_b64encode(secrets.token_bytes(32)).rstrip(b"=").decode("ascii")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode("ascii")).digest()).rstrip(b"=").decode("ascii")
    return verifier, challenge


DONE_PAGE = (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    "<title>PopNow</title><style>body{font:16px/1.5 system-ui,sans-serif;background:#FAF4E8;color:#352242;display:grid;place-items:center;"
    "min-height:100vh;margin:0}main{max-width:28rem;padding:24px;text-align:center}h1{font-size:22px;margin:0 0 8px}</style></head>"
    "<body><main><h1>%s</h1><p>%s</p></main></body></html>"
)


class Loopback(object):
    """A one-shot listener on 127.0.0.1 with a random port, for the OAuth redirect.

    Replies whose state (or iss, when sent) don't match get a 400 and the wait goes on.
    """

    def __init__(self):
        self.expected = None
        self.result = None
        self.done = threading.Event()
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):  # never log: the URL carries the code
                pass

            def _page(self, status, ok, text):
                body = (DONE_PAGE % ("Signed in to PopNow" if ok else "Sign-in did not finish", text)).encode("utf-8")
                self.send_response(status)
                self.send_header("content-type", "text/html; charset=utf-8")
                self.send_header("cache-control", "no-store")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                parsed = urllib.parse.urlparse(self.path)
                with outer.lock:
                    if parsed.path != "/callback" or outer.expected is None or outer.done.is_set():
                        self.send_response(404)
                        self.end_headers()
                        return
                    params = urllib.parse.parse_qs(parsed.query)
                    get = lambda key: params.get(key, [None])[0]
                    state, issuer = outer.expected
                    if get("state") != state:
                        self._page(400, False, "This sign-in link is not the one DaVinci Resolve is waiting for.")
                        return
                    iss = get("iss")
                    if iss is not None and iss.rstrip("/") != issuer.rstrip("/"):
                        self._page(400, False, "The reply came from an unexpected server.")
                        return
                    error, code = get("error"), get("code")
                    if error or not code:
                        outer.result = PopNowError("Sign-in was canceled." if error == "access_denied" else "sign-in failed: %s" % (error or "no code in the reply"))
                        self._page(400, False, "Go back to DaVinci Resolve and sign in again.")
                    else:
                        outer.result = code
                        self._page(200, True, "You can close this tab and go back to DaVinci Resolve.")
                    outer.done.set()

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.redirect_uri = "http://127.0.0.1:%d/callback" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.2})
        self.thread.daemon = True
        self.thread.start()

    def expect(self, state, issuer):
        with self.lock:
            self.expected = (state, issuer)

    def wait(self, timeout=LOGIN_TIMEOUT, cancel=None):
        deadline = time.time() + timeout
        while not self.done.wait(0.2):
            if cancel is not None and cancel.is_set():
                raise PopNowError("Sign-in was canceled.")
            if time.time() > deadline:
                raise PopNowError("Sign-in timed out. Try again.")
        if isinstance(self.result, Exception):
            raise self.result
        return self.result

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def authorize_url(server, client_id, redirect_uri, state, challenge, resource):
    query = urllib.parse.urlencode({
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "scope": SCOPES,
        "state": state,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "resource": resource,
    })
    sep = "&" if "?" in server["authorization_endpoint"] else "?"
    return server["authorization_endpoint"] + sep + query


def _token_request(endpoint, form):
    reply = http("POST", endpoint, {"content-type": "application/x-www-form-urlencoded", "accept": "application/json"},
                 urllib.parse.urlencode(form).encode("ascii"))
    data = reply.json()
    if reply.status != 200 or not isinstance(data.get("access_token"), str):
        raise PopNowError("the sign-in server refused the request (%s)" % (data.get("error") or reply.status))
    return data


def _session_from(reply, base, now):
    session = dict(base)
    session["accessToken"] = reply["access_token"]
    if isinstance(reply.get("refresh_token"), str):
        session["refreshToken"] = reply["refresh_token"]
    if isinstance(reply.get("expires_in"), (int, float)):
        session["expiresAt"] = int(now * 1000 + reply["expires_in"] * 1000)
    if isinstance(reply.get("scope"), str):
        session["scope"] = reply["scope"]
    return session


def login(mcp_url, open_url, cancel=None, timeout=LOGIN_TIMEOUT):
    server = discover(mcp_url)
    loopback = Loopback()
    try:
        client_id = register_client(server, loopback.redirect_uri)
        verifier, challenge = pkce_pair()
        state = secrets.token_urlsafe(16)
        url = authorize_url(server, client_id, loopback.redirect_uri, state, challenge, mcp_url)
        loopback.expect(state, server["issuer"])
        open_url(url)
        code = loopback.wait(timeout, cancel)
        reply = _token_request(server["token_endpoint"], {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": loopback.redirect_uri,
            "client_id": client_id,
            "code_verifier": verifier,
            "resource": mcp_url,
        })
        base = {"issuer": server["issuer"], "mcpUrl": mcp_url, "tokenEndpoint": server["token_endpoint"], "clientId": client_id}
        if "revocation_endpoint" in server:
            base["revocationEndpoint"] = server["revocation_endpoint"]
        return _session_from(reply, base, time.time())
    finally:
        loopback.close()


def refresh(session):
    if not session.get("refreshToken"):
        raise SignInRequired("Your PopNow sign-in expired. Sign in again.")
    reply = _token_request(session["tokenEndpoint"], {
        "grant_type": "refresh_token",
        "refresh_token": session["refreshToken"],
        "client_id": session["clientId"],
        "resource": session["mcpUrl"],
    })
    base = {k: v for k, v in session.items() if k != "accessToken"}
    return _session_from(reply, base, time.time())


def revoke(session):
    endpoint = session.get("revocationEndpoint")
    if not endpoint:
        return False
    ok = True
    for token, hint in ((session.get("refreshToken"), "refresh_token"), (session.get("accessToken"), "access_token")):
        if not token:
            continue
        try:
            reply = http("POST", endpoint, {"content-type": "application/x-www-form-urlencoded"},
                         urllib.parse.urlencode({"token": token, "token_type_hint": hint, "client_id": session["clientId"]}).encode("ascii"))
            ok = ok and reply.status == 200
        except Exception:  # a failed revocation never blocks signing out locally
            ok = False
    return ok


# ---------------------------------------------------------------------------------------------
# Sign-in file (shared with the Workflow Integration plugin)


def config_directory(env=None, home=None, platform=None):
    env = os.environ if env is None else env
    home = os.path.expanduser("~") if home is None else home
    platform = sys.platform if platform is None else platform
    if env.get("POPNOW_CONFIG_DIR"):
        return env["POPNOW_CONFIG_DIR"]
    if platform.startswith("win") and env.get("APPDATA"):
        return os.path.join(env["APPDATA"], "PopNow")
    if platform == "darwin":
        return os.path.join(home, "Library", "Application Support", "PopNow")
    return os.path.join(env.get("XDG_CONFIG_HOME") or os.path.join(home, ".config"), "popnow")


def session_path(env=None):
    return os.path.join(config_directory(env), "davinci-resolve.json")


REQUIRED = ("accessToken", "clientId", "tokenEndpoint", "mcpUrl", "issuer")


def read_session(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = json.load(handle)
    except (IOError, OSError):
        return None
    except ValueError:
        return None  # a damaged file counts as signed out
    if not isinstance(value, dict) or not all(isinstance(value.get(k), str) for k in REQUIRED):
        return None
    return value


def write_session(path, session):
    folder = os.path.dirname(path)
    if not os.path.isdir(folder):
        os.makedirs(folder, 0o700)
    try:
        os.chmod(folder, 0o700)
    except OSError:
        pass
    temp = "%s.%d.tmp" % (path, os.getpid())
    fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(session, handle, indent=2)
        handle.write("\n")
    try:
        os.chmod(temp, 0o600)
    except OSError:
        pass
    os.replace(temp, path)


def delete_session(path):
    try:
        os.remove(path)
    except OSError:
        pass


# ---------------------------------------------------------------------------------------------
# MCP (Streamable HTTP, stateless)


def read_reply(reply, request_id):
    text = reply.body.decode("utf-8")
    messages = []
    if "text/event-stream" in reply.headers.get("content-type", ""):
        for block in re.split(r"\r?\n\r?\n", text):
            data = "\n".join(line[5:].lstrip() for line in re.split(r"\r?\n", block) if line.startswith("data:"))
            if data:
                messages.append(json.loads(data))
    elif text.strip():
        parsed = json.loads(text)
        messages.extend(parsed if isinstance(parsed, list) else [parsed])
    for message in messages:
        if isinstance(message, dict) and message.get("id") == request_id:
            if message.get("error"):
                raise PopNowError(message["error"].get("message") or "the PopNow server returned an error")
            return message.get("result") or {}
    raise PopNowError("the PopNow server sent no reply")


class Client(object):
    def __init__(self, path):
        self.path = path
        session = read_session(path)
        if session is None:
            raise SignInRequired()
        self.session = session
        self.protocol = PROTOCOL_VERSION
        self.session_id = None
        self.initialized = False
        self.next_id = 1

    @property
    def endpoint(self):
        return self.session["mcpUrl"]

    def _renew(self):
        try:
            self.session = refresh(self.session)
        except PopNowError as error:
            raise SignInRequired("Your PopNow sign-in expired. Sign in again. (%s)" % error)
        write_session(self.path, self.session)

    def _post(self, payload, timeout, retried=False):
        expires = self.session.get("expiresAt")
        if expires is not None and expires - 30000 < time.time() * 1000 and not retried:
            self._renew()
        headers = {
            "authorization": "Bearer " + self.session["accessToken"],
            "content-type": "application/json",
            "accept": "application/json, text/event-stream",
            "mcp-protocol-version": self.protocol,
        }
        if self.session_id:
            headers["mcp-session-id"] = self.session_id
        try:
            reply = http("POST", self.endpoint, headers, json.dumps(payload).encode("utf-8"), timeout)
        except socket.timeout:
            raise PopNowError("PopNow took too long to answer. It may still be making this: check your PopNow library before trying again.")
        if reply.status == 401 and not retried:
            self._renew()
            return self._post(payload, timeout, True)
        if reply.status == 401:
            raise SignInRequired()
        if reply.status >= 400:
            raise PopNowError("the PopNow server answered %d: %s" % (reply.status, reply.body[:300].decode("utf-8", "replace").strip()))
        if reply.headers.get("mcp-session-id"):
            self.session_id = reply.headers["mcp-session-id"]
        return reply

    def _request(self, method, params):
        if not self.initialized and method != "initialize":
            self._initialize()
        request_id = self.next_id
        self.next_id += 1
        reply = self._post({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}, 120 if method == "tools/call" else 30)
        return read_reply(reply, request_id)

    def _initialize(self):
        self.initialized = True
        result = self._request("initialize", {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {},
            "clientInfo": {"name": "popnow-davinci-script", "version": VERSION},
        })
        if isinstance(result.get("protocolVersion"), str) and result["protocolVersion"]:
            self.protocol = result["protocolVersion"]
        self._post({"jsonrpc": "2.0", "method": "notifications/initialized"}, 30)

    def call(self, name, args):
        return self._request("tools/call", {"name": name, "arguments": args})


def result_text(result):
    return "\n".join(item.get("text", "") for item in result.get("content") or [] if item.get("type") == "text" and item.get("text"))


def structured(result):
    data = result.get("structuredContent")
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------------------------
# Upload (request_upload -> upload-sessions -> get_upload)

TYPES = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".tif": "image/tiff", ".tiff": "image/tiff",
         ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
         ".wav": "audio/wav", ".mp3": "audio/mpeg", ".m4a": "audio/mp4"}


def content_type_of(path):
    ext = os.path.splitext(path)[1].lower()
    if ext not in TYPES:
        raise PopNowError("PopNow can't use %s files. Use MP4, MOV, PNG, JPG, WAV or MP3." % (ext or "these"))
    return TYPES[ext]


def _envelope(reply):
    data = reply.json()
    if reply.status != 200 or data.get("code") != 200:
        raise PopNowError("Upload failed: %s" % (data.get("msg") or reply.status))
    return data.get("data") or {}


def upload_file(client, path):
    content_type = content_type_of(path)
    kind = content_type.split("/")[0]
    opened = structured(client.call("request_upload", {"kinds": [kind], "max_files": 1, "note": "From DaVinci Resolve"}))
    upload_id, page = opened.get("upload_id"), opened.get("url")
    if not isinstance(upload_id, str) or not isinstance(page, str):
        raise PopNowError("PopNow did not open an upload window.")
    token = [p for p in urllib.parse.urlparse(page).path.split("/") if p][-1]
    mcp = urllib.parse.urlparse(client.endpoint)
    api = "%s://%s/console/v1/upload-sessions/%s" % (mcp.scheme, mcp.netloc, urllib.parse.quote(token, safe=""))
    post = lambda suffix, body=None: http("POST", api + suffix, {"content-type": "application/json", "accept": "application/json"},
                                          None if body is None else json.dumps(body).encode("utf-8"))
    with open(path, "rb") as handle:
        data = handle.read()
    name = os.path.basename(path)
    ticket = _envelope(post("/files", {"contentType": content_type, "bytes": len(data), "name": name}))
    if not isinstance(ticket.get("uploadUrl"), str) or not isinstance(ticket.get("fileId"), str):
        raise PopNowError("Upload failed: no upload address.")
    # The signed address is all the permission storage needs: never send Authorization to it.
    headers = {k: v for k, v in (ticket.get("headers") or {}).items() if k.lower() not in ("content-length", "host", "authorization")}
    put = http(ticket.get("method") or "PUT", ticket["uploadUrl"], headers, data, 30 * 60)
    if put.status >= 300:
        raise PopNowError("Upload of %s failed (%d)." % (name, put.status))
    _envelope(post("/files/%s/commit" % urllib.parse.quote(ticket["fileId"], safe="")))
    try:
        _envelope(post("/close"))
    except PopNowError:
        pass
    files = structured(client.call("get_upload", {"upload_id": upload_id, "wait_seconds": 0})).get("files") or []
    for item in files:
        if item.get("name") == name and isinstance(item.get("popnow_link"), str):
            return item["popnow_link"]
    if files and isinstance(files[0].get("popnow_link"), str):
        return files[0]["popnow_link"]
    raise PopNowError("PopNow did not return a link for %s." % name)


# ---------------------------------------------------------------------------------------------
# Actions, price, start, wait


ACTIONS = [
    {"id": "edit-frame", "title": "Edit image", "tool": "edit_image", "source": "frame", "output": "image",
     "prompt": "What to change", "placeholder": "Golden hour light, add fog"},
    {"id": "frame-to-video", "title": "Image to video", "tool": "create_video", "source": "frame", "output": "video",
     "prompt": "What happens", "placeholder": "Slow push in as the door opens"},
    {"id": "add-sound", "title": "Video to audio", "tool": "add_sound", "source": "clip", "output": "audio",
     "prompt": "Sounds (optional)", "placeholder": "Rain on a window, distant thunder"},
]


def action_by_id(action_id):
    for action in ACTIONS:
        if action["id"] == action_id:
            return action
    raise PopNowError("Unknown action: %s" % action_id)


def build_args(action, prompt, media, clip_seconds=None):
    prompt = (prompt or "").strip()
    if action["id"] == "add-sound":
        seconds = int(min(30, max(1, round(clip_seconds or 8))))
        args = {"video_url": media, "duration_seconds": seconds}
        if prompt:
            args["prompt"] = prompt
        return args
    if not prompt:
        raise PopNowError("Write %s first." % action["prompt"].lower())
    if action["id"] == "edit-frame":
        return {"image_url": media, "prompt": prompt}
    return {"image_url": media, "prompt": prompt, "duration_seconds": 5}


CONSENT_ASK = re.compile(r"consent:\s*true", re.I)
NOT_ENOUGH = re.compile(r"not enough credits", re.I)


def outcome_of(result):
    """Classifies a tool reply: started / price_changed / needs_consent / not_enough / error."""
    text = result_text(result)
    data = structured(result)
    error = result.get("isError") is True
    if data.get("needs_consent") is True or (error and CONSENT_ASK.search(text)):
        return {"kind": "needs_consent", "text": text}
    credits = data.get("credits")
    if data.get("needs_confirmation") is True and isinstance(credits, (int, float)) and credits > 0:
        return {"kind": "price_changed", "credits": int(credits), "text": text}
    if NOT_ENOUGH.search(text) and (error or not data.get("job_id")):
        return {"kind": "not_enough", "text": text}
    if error:
        return {"kind": "error", "text": text or "PopNow could not do this one."}
    return {"kind": "started", "job": job_from(result)}


def job_from(result):
    data = structured(result)
    files = [f for f in (data.get("files") or []) if isinstance(f, dict) and isinstance(f.get("url"), str)]
    status = data.get("status") if isinstance(data.get("status"), str) else ("succeeded" if files else "unknown")
    return {"job_id": data.get("job_id"), "status": status, "files": files, "credits": data.get("credits"), "text": result_text(result)}


def is_done(job):
    return job["status"] in ("succeeded", "failed", "blocked")


EXT = {"video/mp4": ".mp4", "video/quicktime": ".mov", "audio/mpeg": ".mp3", "audio/wav": ".wav", "audio/mp4": ".m4a",
       "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}


def result_name(tool, index, item, at):
    ext = EXT.get(item.get("type") or "")
    if not ext:
        match = re.search(r"\.([a-z0-9]{2,4})$", urllib.parse.urlparse(item["url"]).path, re.I)
        ext = "." + match.group(1).lower() if match else ".bin"
    stamp = time.strftime("%Y%m%d-%H%M%S", time.gmtime(at))
    return "popnow-%s-%s%s%s" % (tool.replace("_", "-"), stamp, "-%d" % (index + 1) if index else "", ext)


def download(job, folder, tool, at=None):
    if not os.path.isdir(folder):
        os.makedirs(folder)
    at = time.time() if at is None else at
    paths = []
    for index, item in enumerate(job["files"]):
        parsed = urllib.parse.urlparse(item["url"])
        if parsed.scheme != "https" and not _is_loopback(parsed):
            raise PopNowError("PopNow returned a download link that is not https.")
        reply = http("GET", item["url"], {}, None, 15 * 60)
        if reply.status != 200:
            raise PopNowError("Download failed (%d)." % reply.status)
        path = os.path.join(folder, result_name(tool, index, item, at))
        with open(path + ".part", "wb") as handle:
            handle.write(reply.body)
        os.replace(path + ".part", path)
        paths.append(path)
    return paths


class Controller(object):
    """Sign-in, price, start, wait and place, shared by both windows. No UI code in here."""

    def __init__(self, host, path=None, mcp_url=None, media_folder=None, temp_folder=None, open_url=None, now=None):
        self.host = host
        self.path = path or session_path()
        self.mcp_url = mcp_url or os.environ.get("POPNOW_MCP_URL") or DEFAULT_MCP_URL
        self.media_folder = media_folder or os.path.join(os.path.expanduser("~"), "Movies" if sys.platform == "darwin" else "Videos", "PopNow")
        self.temp_folder = temp_folder or os.path.join(tempfile.gettempdir(), "popnow-resolve")
        self.open_url = open_url or webbrowser.open
        self.now = now or time.time
        self.pending = {}
        self.uploads = {}
        self.login_cancel = None
        self.stop = threading.Event()

    def signed_in(self):
        return read_session(self.path) is not None

    def login(self):
        self.login_cancel = threading.Event()
        session = login(self.mcp_url, self.open_url, self.login_cancel)
        write_session(self.path, session)
        self.uploads.clear()

    def cancel_login(self):
        if self.login_cancel is not None:
            self.login_cancel.set()

    def logout(self):
        session = read_session(self.path)
        if session:
            revoke(session)
        delete_session(self.path)
        self.uploads.clear()
        self.pending.clear()

    def balance(self):
        credits = structured(Client(self.path).call("check_balance", {})).get("credits")
        return int(credits) if isinstance(credits, (int, float)) else None

    def _link(self, client, path):
        info = os.stat(path)
        key = (path, info.st_size, info.st_mtime)
        if key not in self.uploads:
            self.uploads[key] = upload_file(client, path)
        return self.uploads[key]

    def price(self, action_id, prompt, status=lambda text: None):
        """Uploads the frame or clip (free) and asks PopNow the price. Nothing is charged."""
        action = action_by_id(action_id)
        client = Client(self.path)
        clip_seconds = None
        if action["source"] == "clip":
            clip = self.host.current_clip()
            status("Sending %s…" % clip["name"])
            media = self._link(client, clip["file_path"])
            record_frame, clip_seconds = clip["record_frame"], clip["seconds"]
        else:
            if not os.path.isdir(self.temp_folder):
                os.makedirs(self.temp_folder)
            frame = self.host.export_frame(self.temp_folder, "frame-%d.png" % int(self.now() * 1000))
            status("Sending the frame…")
            media = self._link(client, frame["path"])
            record_frame = frame["record_frame"]
        args = build_args(action, prompt, media, clip_seconds)
        status("Checking the price…")
        result = client.call("estimate_cost", {"tool": action["tool"], "arguments": args})
        data = structured(result)
        if result.get("isError") or not isinstance(data.get("credits"), (int, float)):
            raise PopNowError(result_text(result) or "PopNow could not price this.")
        return self._remember(action, args, int(data["credits"]), data.get("balance"), record_frame)

    def _remember(self, action, args, credits, balance, record_frame):
        now = self.now()
        for key in [k for k, v in self.pending.items() if v["expires"] < now]:
            del self.pending[key]
        quote_id = secrets.token_urlsafe(9)
        self.pending[quote_id] = {"action": action, "args": args, "credits": credits, "record_frame": record_frame, "expires": now + QUOTE_TTL}
        affordable = not isinstance(balance, (int, float)) or credits <= balance
        return {"quote_id": quote_id, "credits": credits, "balance": balance, "affordable": affordable}

    def create(self, quote_id, consent=False, status=lambda text: None):
        """Starts at exactly the quoted price, waits, downloads and places the result."""
        item = self.pending.get(quote_id)
        if item is None or item["expires"] < self.now():
            self.pending.pop(quote_id, None)
            return {"kind": "error", "text": "That price is out of date. Check the price again."}
        del self.pending[quote_id]  # one click, one run
        self.stop.clear()
        client = Client(self.path)
        args = dict(item["args"])
        args["max_credits"] = item["credits"]
        if consent is True:
            args["consent"] = True
        status("Starting…")
        outcome = outcome_of(client.call(item["action"]["tool"], args))
        if outcome["kind"] == "price_changed":
            # Never follow a higher price: it goes back to the user as a new quote.
            again = self._remember(item["action"], item["args"], outcome["credits"], None, item["record_frame"])
            return {"kind": "price_changed", "quote": again}
        if outcome["kind"] == "needs_consent":
            # Nothing started; the same price stays on the button until the user ticks the box.
            self.pending[quote_id] = item
            return outcome
        if outcome["kind"] != "started":
            return outcome
        job = outcome["job"]
        try:
            while not is_done(job):
                if not job.get("job_id"):
                    raise PopNowError("PopNow did not return a job to follow.")
                if self.stop.is_set():
                    raise StoppedWaiting(job["job_id"])
                status("You can keep editing.")
                job_id = job["job_id"]
                job = job_from(client.call("get_job", {"job_id": job_id, "wait_seconds": 10}))
                job["job_id"] = job.get("job_id") or job_id
                if self.stop.is_set() and not is_done(job):
                    raise StoppedWaiting(job_id)
        except StoppedWaiting as stopped:
            return {"kind": "stopped", "text": str(stopped)}
        if job["status"] != "succeeded" or not job["files"]:
            return {"kind": "failed", "text": job["text"] or "This one didn't work. The credits were refunded automatically."}
        status("Bringing it into Resolve…")
        files = download(job, self.media_folder, item["action"]["tool"])
        placed = self.host.place(files, item["action"]["output"], item["record_frame"])
        return {"kind": "done", "files": files, "track": placed["track"], "track_type": placed["track_type"]}

    def stop_waiting(self):
        self.stop.set()


# ---------------------------------------------------------------------------------------------
# DaVinci Resolve (checked by hand: docs/MANUAL-QA.md)


def timecode_to_frames(timecode, fps):
    match = re.match(r"^(\d+):(\d+):(\d+)([:;.,])(\d+)$", timecode.strip())
    if not match:
        raise PopNowError("Unexpected timecode: %s" % timecode)
    h, m, s, f = int(match.group(1)), int(match.group(2)), int(match.group(3)), int(match.group(5))
    base = int(round(fps))
    if match.group(4) == ";" and base in (30, 60):
        drop = 4 if base == 60 else 2
        minutes = h * 60 + m
        return ((h * 60 + m) * 60 + s) * base + f - drop * (minutes - minutes // 10)
    return ((h * 60 + m) * 60 + s) * base + f


class ResolveHost(object):
    def __init__(self, resolve):
        self.resolve = resolve

    def _project(self):
        manager = self.resolve.GetProjectManager()
        project = manager.GetCurrentProject() if manager else None
        if not project:
            raise PopNowError("Open a project in DaVinci Resolve first.")
        return project

    def _timeline(self, project=None):
        timeline = (project or self._project()).GetCurrentTimeline()
        if not timeline:
            raise PopNowError("Open a timeline first.")
        return timeline

    def _fps(self, timeline):
        try:
            fps = float(timeline.GetSetting("timelineFrameRate"))
        except (TypeError, ValueError):
            fps = 24.0
        return fps if fps > 0 else 24.0

    def current_clip(self):
        timeline = self._timeline()
        item = timeline.GetCurrentVideoItem()
        if not item:
            raise PopNowError("Park the playhead on a video clip first.")
        pool_item = item.GetMediaPoolItem()
        path = pool_item.GetClipProperty("File Path") if pool_item else ""
        if not path:
            raise PopNowError("This clip has no source file on disk (generated or compound clips can't be sent).")
        fps = self._fps(timeline)
        frames = int(item.GetDuration())
        return {"name": item.GetName(), "file_path": path, "record_frame": int(item.GetStart()), "seconds": frames / fps}

    def export_frame(self, folder, name):
        project = self._project()
        timeline = self._timeline(project)
        path = os.path.join(folder, name)
        if not project.ExportCurrentFrameAsStill(path):
            raise PopNowError("Resolve could not export the current frame. Open the Edit or Color page and try again.")
        return {"path": path, "record_frame": timecode_to_frames(timeline.GetCurrentTimecode(), self._fps(timeline))}

    def place(self, paths, kind, record_frame):
        project = self._project()
        timeline = self._timeline(project)
        pool = project.GetMediaPool()
        root = pool.GetRootFolder()
        folders = root.GetSubFolderList() or []
        if isinstance(folders, dict):
            folders = list(folders.values())
        bin_ = next((f for f in folders if f.GetName() == "PopNow"), None) or pool.AddSubFolder(root, "PopNow")
        if bin_:
            pool.SetCurrentFolder(bin_)
        items = pool.ImportMedia(list(paths)) or []
        if not items:
            raise PopNowError("Resolve could not import the result. It is saved here: %s" % ", ".join(paths))
        track_type = "audio" if kind == "audio" else "video"
        added = timeline.AddTrack("audio", "stereo") if track_type == "audio" else timeline.AddTrack("video")
        if not added:
            raise PopNowError("Resolve could not add a new track.")
        track = int(timeline.GetTrackCount(track_type))
        infos, at = [], record_frame
        for item in items:
            info = {"mediaPoolItem": item, "trackIndex": track, "recordFrame": at}
            try:
                frames = int(item.GetClipProperty("Frames"))
            except (TypeError, ValueError):
                frames = 0
            if frames > 0:
                info["startFrame"], info["endFrame"] = 0, frames - 1
                at += frames
            if track_type == "audio":
                info["mediaType"] = 2
            infos.append(info)
        if not pool.AppendToTimeline(infos):
            raise PopNowError("The result is in the PopNow bin, but Resolve could not put it on the timeline.")
        return {"track": track, "track_type": track_type}


# ---------------------------------------------------------------------------------------------
# Window 1: Resolve's UIManager


PAPER, PLUM, ORANGE = "#FAF4E8", "#352242", "#E65A2F"


def run_uimanager(resolve, controller, fusion, bmd):
    ui = fusion.UIManager
    disp = bmd.UIDispatcher(ui)
    jobs = queue.Queue()
    state = {"quote": None, "busy": False}

    win = disp.AddWindow({"ID": "PopNowWin", "WindowTitle": "PopNow", "Geometry": [200, 200, 380, 420],
                          "StyleSheet": "QWidget{background:%s;color:%s;} QPushButton{border-radius:10px;padding:8px;}" % (PAPER, PLUM)}, [
        ui.VGroup({"Spacing": 8}, [
            ui.HGroup({"Weight": 0}, [
                ui.Label({"ID": "Brand", "Text": "<b>PopNow</b>", "Weight": 1}),
                ui.Label({"ID": "Balance", "Text": "", "Alignment": {"AlignRight": True}}),
            ]),
            ui.Button({"ID": "SignIn", "Text": "Sign in to PopNow", "Weight": 0,
                       "StyleSheet": "background:%s;color:#FFF6E6;font-weight:bold;min-height:36px;" % ORANGE}),
            ui.ComboBox({"ID": "Action", "Weight": 0}),
            ui.TextEdit({"ID": "Prompt", "PlaceholderText": ACTIONS[0]["placeholder"], "Weight": 1}),
            ui.CheckBox({"ID": "Consent", "Text": "The people in it are me or agreed; nobody is under 18.", "Weight": 0, "Hidden": True}),
            ui.Button({"ID": "Go", "Text": "Get price", "Weight": 0,
                       "StyleSheet": "background:%s;color:#FFF6E6;font-weight:bold;min-height:40px;" % ORANGE}),
            ui.HGroup({"Weight": 0}, [
                ui.Label({"ID": "Status", "Text": "", "Weight": 1, "WordWrap": True}),
                ui.Button({"ID": "GetCredits", "Text": "Get credits", "Weight": 0, "Hidden": True, "Flat": True}),
                ui.Button({"ID": "Stop", "Text": "Stop waiting", "Weight": 0, "Hidden": True, "Flat": True,
                           "ToolTip": "It keeps going on PopNow and is saved to your library"}),
                ui.Button({"ID": "SignOut", "Text": "Sign out", "Weight": 0, "Flat": True}),
            ]),
        ]),
    ])
    items = win.GetItems()
    for action in ACTIONS:
        items["Action"].AddItem(action["title"])

    def current_action():
        return ACTIONS[int(items["Action"].CurrentIndex or 0)]

    def set_status(text):
        items["Status"].Text = text

    def refresh():
        signed = controller.signed_in()
        for key in ("Action", "Prompt", "Go", "SignOut"):
            items[key].Hidden = not signed
        items["SignIn"].Hidden = signed
        quote = state["quote"]
        items["GetCredits"].Hidden = not (quote and not quote["affordable"])
        if state["busy"]:
            items["Go"].Enabled = False
            return
        if quote:
            items["Go"].Text = "Create · {:,} credits".format(quote["credits"])
            items["Go"].Enabled = quote["affordable"]
        else:
            items["Go"].Text = "Get price"
            items["Go"].Enabled = True

    def work(fn, done):
        """Runs fn off the UI thread; done(result_or_error) runs back on it through the timer."""
        state["busy"] = True
        refresh()

        def runner():
            try:
                jobs.put((done, fn(), None))
            except Exception as error:  # shown in the window, never the tokens
                jobs.put((done, None, error))
        thread = threading.Thread(target=runner)
        thread.daemon = True
        thread.start()

    def post_status(text):
        jobs.put((lambda result, error: set_status(text), None, None))

    def on_tick(ev):
        while True:
            try:
                done, result, error = jobs.get_nowait()
            except queue.Empty:
                break
            done(result, error)

    def finish(result, error):
        state["busy"] = False
        items["Stop"].Hidden = True
        if isinstance(error, SignInRequired):
            set_status(str(error))
        elif error is not None:
            set_status(str(error))
        refresh()

    def on_sign_in(ev):
        set_status("Finish signing in in your browser…")
        work(controller.login, lambda r, e: (finish(r, e), e is None and on_balance(None)))

    def on_sign_out(ev):
        controller.logout()
        state["quote"] = None
        items["Balance"].Text = ""
        set_status("")
        refresh()

    def on_balance(ev):
        def shown(result, error):
            finish(None, error)
            if error is None and result is not None:
                items["Balance"].Text = "{:,} credits".format(result)
        work(controller.balance, shown)

    def on_change(ev):
        if state["busy"]:
            return
        state["quote"] = None
        items["Prompt"].PlaceholderText = current_action()["placeholder"]
        refresh()

    def on_go(ev):
        if state["busy"]:
            return
        quote = state["quote"]
        if quote is None:
            action, prompt = current_action(), items["Prompt"].PlainText

            def priced(result, error):
                if error is None:
                    state["quote"] = result
                    if isinstance(result.get("balance"), (int, float)):
                        items["Balance"].Text = "{:,} credits".format(int(result["balance"]))
                    set_status("" if result["affordable"] else "Not enough credits.")
                finish(None, error)
            work(lambda: controller.price(action["id"], prompt, post_status), priced)
            return
        state["quote"] = None
        items["Stop"].Hidden = False
        consent = bool(items["Consent"].Checked)

        def created(result, error):
            if error is None:
                kind = result["kind"]
                if kind == "done":
                    set_status("Added to %s%d" % ("A" if result["track_type"] == "audio" else "V", result["track"]))
                elif kind == "price_changed":
                    state["quote"] = result["quote"]
                    set_status("The price changed. Nothing was charged.")
                elif kind == "needs_consent":
                    state["quote"] = quote
                    items["Consent"].Hidden = False
                    set_status("Tick the box to confirm, then click again. Nothing was charged.")
                elif kind == "not_enough":
                    state["quote"] = dict(quote, affordable=False)
                    set_status("Not enough credits. Nothing was charged.")
                else:
                    set_status(result.get("text") or "")
            finish(None, error)
            if error is None and result["kind"] == "done":
                on_balance(None)
        work(lambda: controller.create(quote["quote_id"], consent, post_status), created)

    win.On.PopNowWin.Close = lambda ev: disp.ExitLoop()
    win.On.SignIn.Clicked = on_sign_in
    win.On.SignOut.Clicked = on_sign_out
    win.On.Go.Clicked = on_go
    win.On.Stop.Clicked = lambda ev: controller.stop_waiting()
    win.On.GetCredits.Clicked = lambda ev: webbrowser.open(PRICING_URL)
    win.On.Action.CurrentIndexChanged = on_change
    win.On.Prompt.TextChanged = on_change
    win.On.Consent.Clicked = lambda ev: refresh()

    timer = ui.Timer({"ID": "PopNowTick", "Interval": 150})
    disp.On.PopNowTick.Timeout = on_tick
    timer.Start()
    refresh()
    if controller.signed_in():
        on_balance(None)
    win.Show()
    disp.RunLoop()
    timer.Stop()
    win.Hide()


# ---------------------------------------------------------------------------------------------
# Window 2: a page on 127.0.0.1, for free editions where UIManager is turned off (19.1 and later)

PAGE = """<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>PopNow · DaVinci Resolve</title><style>
:root{--bg:#FAF4E8;--panel:#FFFCF6;--ink:#352242;--line:rgba(53,34,66,.14);--accent:#E65A2F;--muted:rgba(53,34,66,.6)}
@media (prefers-color-scheme:dark){:root{--bg:#170D1E;--panel:#1F1228;--ink:#FAF4E8;--line:rgba(250,244,232,.12);--muted:rgba(250,244,232,.6)}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,sans-serif;display:grid;place-items:start center}
main{width:min(420px,100% - 32px);margin:32px 0;padding:20px;border:1px solid var(--line);border-radius:20px;background:var(--panel);display:grid;gap:12px}
h1{margin:0;font:800 22px/1.1 ui-rounded,system-ui;letter-spacing:-.02em;display:flex;justify-content:space-between;align-items:center}
#bal{font:700 13px system-ui}select,textarea{width:100%;box-sizing:border-box;padding:9px 10px;border-radius:10px;border:1px solid var(--line);background:transparent;color:inherit;font:inherit}
textarea{min-height:110px;resize:vertical}label{display:flex;gap:8px;color:var(--muted)}
.jelly{height:44px;border:0;border-radius:12px;color:#FFF6E6;font:700 15px system-ui;cursor:pointer;background:linear-gradient(180deg,#EC6437,#E65A2F 42%,#DC5028);box-shadow:inset 0 1px 0 rgba(255,222,196,.72),inset 0 -2px 0 rgba(96,28,8,.44),0 8px 14px -10px rgba(110,36,12,.62)}
.jelly:disabled{background:rgba(127,127,127,.18);color:var(--muted);box-shadow:none;cursor:default}
.row{display:flex;gap:12px;align-items:center;min-height:18px}#status{flex:1;color:var(--muted)}a,button.link{color:inherit;background:none;border:0;padding:0;text-decoration:underline;cursor:pointer;font:inherit}
[hidden]{display:none!important}</style></head><body><main>
<h1>PopNow <span id="bal"></span></h1>
<button class="jelly" id="signin" hidden>Sign in to PopNow</button>
<div id="work" hidden>
<select id="action"></select>
<p></p><textarea id="prompt"></textarea>
<label id="consent-row" hidden><input type="checkbox" id="consent">The people in it are me or agreed; nobody is under 18.</label>
<p></p><button class="jelly" id="go" style="width:100%">Get price</button>
</div>
<div class="row"><span id="status" role="status"></span><button class="link" id="credits" hidden>Get credits</button>
<button class="link" id="stop" hidden title="It keeps going on PopNow and is saved to your library">Stop waiting</button>
<button class="link" id="signout" hidden>Sign out</button><button class="link" id="close">Close</button></div>
</main><script>
const base = location.pathname.replace(/\\/$/, "");
const post = (p, b) => fetch(base + "/api/" + p, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(b || {})}).then(r => r.json());
const $ = id => document.getElementById(id); let quote = null, busy = false;
const fmt = n => Number(n).toLocaleString("en-US");
function paint(s) {
  $("signin").hidden = s.signedIn; $("work").hidden = !s.signedIn; $("signout").hidden = !s.signedIn;
  if (s.balance != null) $("bal").textContent = fmt(s.balance) + " credits";
  $("go").disabled = busy || (quote && !quote.affordable);
  $("go").textContent = quote ? "Create · " + fmt(quote.credits) + " credits" : "Get price";
  $("credits").hidden = !(quote && !quote.affordable); $("stop").hidden = !busy || !quote_running;
}
let quote_running = false;
async function state() { const s = await post("state"); paint(s); return s; }
async function poll() { if (!busy) return; const s = await post("progress"); if (s.status) $("status").textContent = s.status; setTimeout(poll, 800); }
async function run(path, body, running) { busy = true; quote_running = !!running; paint({signedIn: true}); poll();
  try { return await post(path, body); } finally { busy = false; quote_running = false; } }
$("signin").onclick = async () => { $("status").textContent = "Finish signing in in your browser…"; const r = await post("login"); $("status").textContent = r.error || ""; await state(); };
$("signout").onclick = async () => { await post("logout"); quote = null; $("bal").textContent = ""; await state(); };
$("close").onclick = async () => { await post("close"); document.body.innerHTML = "<main><h1>You can close this tab.</h1></main>"; };
$("credits").onclick = () => post("credits");
$("stop").onclick = () => post("stop");
$("action").onchange = $("prompt").oninput = () => { if (!busy) { quote = null; state(); } };
$("go").onclick = async () => {
  if (!quote) { const r = await run("price", {action: $("action").value, prompt: $("prompt").value});
    if (r.error) $("status").textContent = r.error; else { quote = r; $("status").textContent = r.affordable ? "" : "Not enough credits."; } return state(); }
  const q = quote; quote = null;
  const r = await run("create", {quote_id: q.quote_id, consent: $("consent").checked}, true);
  if (r.error) $("status").textContent = r.error;
  else if (r.kind === "done") $("status").textContent = "Added to " + (r.track_type === "audio" ? "A" : "V") + r.track;
  else if (r.kind === "price_changed") { quote = r.quote; $("status").textContent = "The price changed. Nothing was charged."; }
  else if (r.kind === "needs_consent") { quote = q; $("consent-row").hidden = false; $("status").textContent = "Tick the box to confirm, then click again. Nothing was charged."; }
  else if (r.kind === "not_enough") { quote = Object.assign({}, q, {affordable: false}); $("status").textContent = "Not enough credits. Nothing was charged."; }
  else $("status").textContent = r.text || "";
  state();
};
(async () => { const a = await post("actions"); for (const x of a) { const o = document.createElement("option"); o.value = x.id; o.textContent = x.title; $("action").append(o); } state(); })();
</script></body></html>"""


class ThreadingServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class BrowserPanel(object):
    """The same controls as the UIManager window, as a page on 127.0.0.1 behind a random path."""

    def __init__(self, controller, idle_seconds=2 * 3600):
        self.controller = controller
        self.secret = secrets.token_urlsafe(18)
        self.status = ""
        self.closed = threading.Event()
        self.idle_seconds = idle_seconds
        self.last_seen = time.time()
        panel = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _send(self, status, body, content_type):
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("cache-control", "no-store")
                self.send_header("x-frame-options", "DENY")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _allowed(self):
                host = (self.headers.get("host") or "").split(":")[0]
                return host in ("127.0.0.1", "localhost") and self.path.startswith("/" + panel.secret)

            def do_GET(self):
                if not self._allowed():
                    return self._send(404, b"", "text/plain")
                panel.last_seen = time.time()
                self._send(200, PAGE.encode("utf-8"), "text/html; charset=utf-8")

            def do_POST(self):
                if not self._allowed() or "application/json" not in (self.headers.get("content-type") or ""):
                    return self._send(404, b"", "text/plain")
                panel.last_seen = time.time()
                length = int(self.headers.get("content-length") or 0)
                try:
                    body = json.loads(self.rfile.read(length).decode("utf-8") or "{}")
                except ValueError:
                    body = {}
                name = self.path[len(panel.secret) + 1:].lstrip("/").replace("api/", "", 1)
                try:
                    reply = panel.handle(name, body)
                except Exception as error:
                    reply = {"error": str(error)}
                self._send(200, json.dumps(reply).encode("utf-8"), "application/json")

        self.server = ThreadingServer(("127.0.0.1", 0), Handler)
        self.url = "http://127.0.0.1:%d/%s/" % (self.server.server_address[1], self.secret)

    def _status(self, text):
        self.status = text

    def handle(self, name, body):
        c = self.controller
        if name == "actions":
            return [{"id": a["id"], "title": a["title"]} for a in ACTIONS]
        if name == "state":
            signed = c.signed_in()
            balance = None
            if signed:
                try:
                    balance = c.balance()
                except SignInRequired:
                    signed = False
            return {"signedIn": signed, "balance": balance}
        if name == "progress":
            return {"status": self.status}
        if name == "login":
            c.login()
            return {"ok": True}
        if name == "logout":
            c.logout()
            return {"ok": True}
        if name == "price":
            return c.price(str(body.get("action")), str(body.get("prompt") or ""), self._status)
        if name == "create":
            return c.create(str(body.get("quote_id")), body.get("consent") is True, self._status)
        if name == "stop":
            c.stop_waiting()
            return {"ok": True}
        if name == "credits":
            webbrowser.open(PRICING_URL)
            return {"ok": True}
        if name == "close":
            self.closed.set()
            return {"ok": True}
        return {"error": "unknown request"}

    def serve(self, open_page=True):
        thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.3})
        thread.daemon = True
        thread.start()
        if open_page:
            webbrowser.open(self.url)
        while not self.closed.wait(1):
            if time.time() - self.last_seen > self.idle_seconds:
                break
        self.server.shutdown()
        self.server.server_close()


# ---------------------------------------------------------------------------------------------


def main():
    resolve_obj = globals().get("resolve")
    if resolve_obj is None:
        try:
            import DaVinciResolveScript as dvr  # noqa: F401  (external scripting, Studio only)
            resolve_obj = dvr.scriptapp("Resolve")
        except Exception:
            resolve_obj = None
    if resolve_obj is None:
        print("PopNow: run this from DaVinci Resolve: Workspace > Scripts > PopNow.")
        return
    controller = Controller(ResolveHost(resolve_obj))
    fusion = resolve_obj.Fusion() if hasattr(resolve_obj, "Fusion") else None
    bmd_mod = globals().get("bmd")
    ui = None
    try:
        ui = fusion.UIManager if fusion is not None else None
    except Exception:
        ui = None
    if ui is not None and bmd_mod is not None:
        try:
            run_uimanager(resolve_obj, controller, fusion, bmd_mod)
            return
        except Exception as error:  # UIManager is switched off in the free edition from 19.1
            print("PopNow: opening the panel in your browser (%s)" % error.__class__.__name__)
    panel = BrowserPanel(controller)
    print("PopNow is open in your browser: %s" % panel.url)
    panel.serve()


# Resolve runs Workspace > Scripts entries with `resolve` (and `bmd`) already defined.
if __name__ == "__main__" or "resolve" in globals():
    main()
