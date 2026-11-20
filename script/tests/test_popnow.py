"""Tests for script/PopNow.py against a fake PopNow on 127.0.0.1 (no network, no Resolve).

    python3 -m unittest discover -s script/tests -v
"""

import importlib.util
import json
import os
import shutil
import stat
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("PopNow", os.path.join(HERE, "..", "PopNow.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


class Fake(object):
    def __init__(self):
        self.calls = []
        self.registered = []
        self.uploads = []
        self.put_auth = []
        self.revoked = []
        self.refreshed = 0
        self.prices = {"edit_image": 48, "create_video": 185, "add_sound": 30}
        self.balance = 1000
        self.raise_by = 0
        self.expire = None
        self.polls_before_done = 1
        self.poll_delay = 0
        self.json = False
        self.consent_required = False
        self.polls = 0
        fake = self

        class Server(ThreadingMixIn, HTTPServer):
            daemon_threads = True

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _body(self):
                return self.rfile.read(int(self.headers.get("content-length") or 0))

            def _json(self, status, value, extra=None):
                body = json.dumps(value).encode()
                self.send_response(status)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                o = fake.origin
                url = urllib.parse.urlparse(self.path)
                if url.path == "/.well-known/oauth-protected-resource/mcp":
                    return self._json(200, {"resource": o + "/mcp", "authorization_servers": [o]})
                if url.path == "/.well-known/oauth-authorization-server":
                    meta = {"issuer": o, "authorization_endpoint": o + "/oauth/authorize", "token_endpoint": o + "/oauth/token",
                            "registration_endpoint": o + "/oauth/register", "revocation_endpoint": o + "/oauth/revoke"}
                    meta.update(getattr(fake, "meta", {}) or {})
                    return self._json(200, meta)
                if url.path == "/oauth/authorize":
                    q = dict(urllib.parse.parse_qsl(url.query))
                    assert q["code_challenge_method"] == "S256" and q["scope"] == "generate read" and q["resource"] == o + "/mcp"
                    back = q["redirect_uri"] + "?" + urllib.parse.urlencode({"code": "code-1", "state": q["state"], "iss": o})
                    self.send_response(302)
                    self.send_header("location", back)
                    self.end_headers()
                    return
                if url.path.startswith("/media/"):
                    body = b"result-bytes"
                    self.send_response(200)
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.end_headers()

            def do_PUT(self):
                fake.put_auth.append(self.headers.get("authorization"))
                fake.uploads.append("PUT %s:%d" % (self.path, len(self._body())))
                self.send_response(200)
                self.send_header("content-length", "0")
                self.end_headers()

            def do_POST(self):
                o = fake.origin
                url = urllib.parse.urlparse(self.path)
                raw = self._body()
                if url.path == "/oauth/register":
                    reg = json.loads(raw)
                    fake.registered.append(reg)
                    return self._json(201, {"client_id": "pnc_script", "redirect_uris": reg["redirect_uris"]})
                if url.path == "/oauth/token":
                    form = dict(urllib.parse.parse_qsl(raw.decode()))
                    if form["grant_type"] == "authorization_code":
                        assert form["code"] == "code-1" and form["code_verifier"]
                        return self._json(200, {"access_token": "at-1", "refresh_token": "rt-1", "expires_in": 3600, "scope": "generate read"})
                    assert form["refresh_token"] == "rt-1"
                    fake.refreshed += 1
                    return self._json(200, {"access_token": "at-2", "expires_in": 3600})
                if url.path == "/oauth/revoke":
                    fake.revoked.append(dict(urllib.parse.parse_qsl(raw.decode()))["token"])
                    return self._json(200, {})
                if url.path.startswith("/console/v1/upload-sessions/tok123"):
                    rest = url.path[len("/console/v1/upload-sessions/tok123"):]
                    fake.uploads.append("POST " + rest)
                    if rest == "/files":
                        req = json.loads(raw)
                        fake.uploads.append("file %s:%d:%s" % (req["name"], req["bytes"], req["contentType"]))
                        return self._json(200, {"code": 200, "data": {"fileId": "f1", "uploadUrl": o + "/put/f1", "method": "PUT",
                                                                      "headers": {"content-type": req["contentType"], "Authorization": "nope"}}})
                    return self._json(200, {"code": 200, "data": {}})
                if url.path == "/mcp":
                    auth = self.headers.get("authorization")
                    if fake.expire and auth == "Bearer " + fake.expire:
                        fake.expire = None
                        self.send_response(401)
                        self.send_header("content-length", "0")
                        self.end_headers()
                        return
                    msg = json.loads(raw)
                    params = msg.get("params") or {}
                    fake.calls.append({"method": msg["method"], "name": params.get("name"), "args": params.get("arguments"), "auth": auth})
                    if "id" not in msg:
                        self.send_response(202)
                        self.send_header("content-length", "0")
                        self.end_headers()
                        return
                    result = fake.tool(params.get("name"), params.get("arguments") or {}) if msg["method"] == "tools/call" else {"protocolVersion": "2025-06-18"}
                    if fake.json:
                        return self._json(200, {"jsonrpc": "2.0", "id": msg["id"], "result": result})
                    body = ("event: message\ndata: %s\n\n" % json.dumps({"jsonrpc": "2.0", "id": msg["id"], "result": result})).encode()
                    self.send_response(200)
                    self.send_header("content-type", "text/event-stream")
                    self.send_header("content-length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                    return
                self.send_response(404)
                self.send_header("content-length", "0")
                self.end_headers()

        self.server = Server(("127.0.0.1", 0), Handler)
        self.origin = "http://127.0.0.1:%d" % self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever)
        self.thread.daemon = True
        self.thread.start()

    def tool(self, name, args):
        def text(t, sc=None, error=False):
            out = {"content": [{"type": "text", "text": t}]}
            if sc is not None:
                out["structuredContent"] = sc
            if error:
                out["isError"] = True
            return out
        if name == "check_balance":
            return text("You have %d credits." % self.balance, {"currency": "credits", "credits": self.balance, "held": 0})
        if name == "estimate_cost":
            credits = self.prices.get(args["tool"], 10)
            return text("about %d credits" % credits, {"credits": credits, "balance": self.balance})
        if name == "request_upload":
            return text("ready", {"upload_id": "up_1", "url": self.origin + "/upload/tok123"})
        if name == "get_upload":
            return text("1 file", {"upload_id": "up_1", "files": [{"popnow_link": "popnow://f/src", "name": "frame.png"}]})
        if name == "get_job":
            if self.poll_delay:
                time.sleep(self.poll_delay)
            self.polls += 1
            if self.polls > self.polls_before_done:
                return text("Done!", {"job_id": args["job_id"], "status": "succeeded", "files": [{"url": self.origin + "/media/x.png", "type": "image/png"}]})
            return text("Still making it.", {"job_id": args["job_id"], "status": "running"})
        price = self.prices.get(name, 0) + self.raise_by
        if self.consent_required and args.get("consent") is not True:
            return text("call this tool again with consent: true. Nothing was charged.", None, True)
        if price > self.balance:
            return text("Not enough credits: this needs %d credits." % price, None, True)
        if price > (args.get("max_credits") or 0):
            return text("Needs confirmation.", {"needs_confirmation": True, "credits": price, "balance": self.balance})
        self.polls = 0
        return text("Started!", {"job_id": "job_1", "status": "running", "credits": price})

    def close(self):
        self.server.shutdown()
        self.server.server_close()


class FakeHost(object):
    def __init__(self, folder):
        self.folder = folder
        self.placed = []

    def current_clip(self):
        path = os.path.join(self.folder, "clip.mov")
        with open(path, "wb") as handle:
            handle.write(b"\0" * 512)
        return {"name": "Clip A", "file_path": path, "record_frame": 86400, "seconds": 4.2}

    def export_frame(self, folder, name):
        path = os.path.join(folder, name)
        with open(path, "wb") as handle:
            handle.write(b"\x89PNG")
        return {"path": path, "record_frame": 86424}

    def place(self, paths, kind, record_frame):
        self.placed.append((list(paths), kind, record_frame))
        return {"track": 2, "track_type": "audio" if kind == "audio" else "video"}


def browser(url):
    """Follows the sign-in link like a browser would: authorize -> 302 -> loopback callback."""
    reply = P.http("GET", url)
    assert reply.status == 302, reply.status
    P.http("GET", reply.headers["location"])
    return True


class ScriptTests(unittest.TestCase):
    def setUp(self):
        self.fake = Fake()
        self.dir = tempfile.mkdtemp(prefix="popnow-script-")
        self.host = FakeHost(self.dir)
        self.path = os.path.join(self.dir, "config", "davinci-resolve.json")
        self.controller = P.Controller(self.host, path=self.path, mcp_url=self.fake.origin + "/mcp",
                                       media_folder=os.path.join(self.dir, "media"), temp_folder=os.path.join(self.dir, "tmp"), open_url=browser)

    def tearDown(self):
        self.fake.close()
        shutil.rmtree(self.dir, ignore_errors=True)

    def calls(self, name):
        return [c for c in self.fake.calls if c["method"] == "tools/call" and c["name"] == name]

    def sign_in(self):
        self.controller.login()

    def test_sign_in_keeps_tokens_private(self):
        self.sign_in()
        reg = self.fake.registered[0]
        self.assertRegex(reg["redirect_uris"][0], r"^http://127\.0\.0\.1:\d+/callback$")
        self.assertEqual(reg["token_endpoint_auth_method"], "none")
        self.assertEqual(reg["scope"], "generate read")
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(os.stat(self.path).st_mode), 0o600)
        with open(self.path) as handle:
            saved = json.load(handle)
        self.assertEqual((saved["accessToken"], saved["refreshToken"]), ("at-1", "rt-1"))

    def test_wrong_state_or_issuer_gets_400_and_the_wait_goes_on(self):
        def tricky(url):
            q = dict(urllib.parse.parse_qsl(urllib.parse.urlparse(url).query))
            bad = q["redirect_uri"] + "?" + urllib.parse.urlencode({"code": "evil", "state": "wrong"})
            self.assertEqual(P.http("GET", bad).status, 400)
            bad_iss = q["redirect_uri"] + "?" + urllib.parse.urlencode({"code": "evil", "state": q["state"], "iss": "https://evil.example"})
            self.assertEqual(P.http("GET", bad_iss).status, 400)
            return browser(url)
        self.controller.open_url = tricky
        self.controller.login()
        self.assertTrue(self.controller.signed_in())

    def test_refuses_insecure_or_mismatched_servers(self):
        with self.assertRaisesRegex(P.PopNowError, "https"):
            P.discover("http://popnow.example/mcp")
        self.fake.meta = {"issuer": "https://other.example"}
        with self.assertRaisesRegex(P.PopNowError, "issuer"):
            P.discover(self.fake.origin + "/mcp")

    def test_price_uploads_the_frame_and_charges_nothing(self):
        self.sign_in()
        quote = self.controller.price("edit-frame", "golden hour")
        self.assertEqual(quote["credits"], 48)
        self.assertTrue(quote["affordable"])
        self.assertEqual([u for u in self.fake.uploads if not u.startswith("file ")], ["POST /files", "PUT /put/f1:4", "POST /files/f1/commit", "POST /close"])
        self.assertEqual(self.fake.put_auth, [None])
        self.assertEqual(self.calls("estimate_cost")[0]["args"], {"tool": "edit_image", "arguments": {"image_url": "popnow://f/src", "prompt": "golden hour"}})
        self.assertEqual(self.calls("edit_image"), [])

    def test_create_at_the_quoted_price_then_poll_download_and_place(self):
        self.sign_in()
        quote = self.controller.price("edit-frame", "golden hour")
        done = self.controller.create(quote["quote_id"])
        self.assertEqual(done["kind"], "done")
        self.assertEqual(self.calls("edit_image")[0]["args"], {"image_url": "popnow://f/src", "prompt": "golden hour", "max_credits": 48})
        self.assertGreaterEqual(len(self.calls("get_job")), 1)
        paths, kind, frame = self.host.placed[0]
        self.assertEqual((kind, frame), ("image", 86424))
        with open(paths[0], "rb") as handle:
            self.assertEqual(handle.read(), b"result-bytes")
        self.assertEqual(self.controller.create(quote["quote_id"])["kind"], "error")  # one click, one run

    def test_never_follows_a_higher_price(self):
        self.sign_in()
        quote = self.controller.price("frame-to-video", "push in")
        self.fake.raise_by = 40
        out = self.controller.create(quote["quote_id"])
        self.assertEqual(out["kind"], "price_changed")
        self.assertEqual(out["quote"]["credits"], 225)
        self.assertEqual([c["args"]["max_credits"] for c in self.calls("create_video")], [185])
        self.assertEqual(self.calls("get_job"), [])

    def test_consent_only_when_the_user_ticks_it(self):
        self.fake.consent_required = True
        self.sign_in()
        quote = self.controller.price("frame-to-video", "push in")
        self.assertEqual(self.controller.create(quote["quote_id"], consent=False)["kind"], "needs_consent")
        self.assertNotIn("consent", self.calls("create_video")[0]["args"])
        self.assertEqual(self.controller.create(quote["quote_id"], consent=True)["kind"], "done")
        self.assertIs(self.calls("create_video")[1]["args"]["consent"], True)

    def test_not_enough_credits(self):
        self.fake.balance = 20
        self.sign_in()
        quote = self.controller.price("frame-to-video", "push in")
        self.assertFalse(quote["affordable"])
        self.assertEqual(self.controller.create(quote["quote_id"])["kind"], "not_enough")

    def test_video_to_audio_sends_the_clip_and_lands_on_an_audio_track(self):
        self.sign_in()
        quote = self.controller.price("add-sound", "")
        self.assertEqual(self.calls("estimate_cost")[0]["args"]["arguments"], {"video_url": "popnow://f/src", "duration_seconds": 4})
        self.assertIn("file clip.mov:512:video/quicktime", self.fake.uploads)
        self.controller.create(quote["quote_id"])
        self.assertEqual(self.host.placed[0][1:], ("audio", 86400))

    def test_stop_waiting_leaves_the_job_running(self):
        self.fake.polls_before_done = 100
        self.fake.poll_delay = 0.05
        self.sign_in()
        quote = self.controller.price("edit-frame", "x")
        timer = threading.Timer(0.3, self.controller.stop_waiting)
        timer.start()
        out = self.controller.create(quote["quote_id"])
        self.assertEqual(out["kind"], "stopped")
        self.assertIn("keeps making it", out["text"])
        self.assertEqual(self.host.placed, [])

    def test_refreshes_once_on_401(self):
        self.sign_in()
        self.fake.expire = "at-1"
        self.assertEqual(self.controller.balance(), 1000)
        self.assertEqual(self.fake.refreshed, 1)
        with open(self.path) as handle:
            self.assertEqual(json.load(handle)["accessToken"], "at-2")

    def test_reads_plain_json_replies(self):
        self.fake.json = True
        self.sign_in()
        self.assertEqual(self.controller.balance(), 1000)

    def test_sign_out_revokes_and_deletes(self):
        self.sign_in()
        self.controller.logout()
        self.assertEqual(self.fake.revoked, ["rt-1", "at-1"])
        self.assertFalse(os.path.exists(self.path))
        with self.assertRaises(P.SignInRequired):
            self.controller.balance()

    def test_quotes_expire(self):
        now = [time.time()]
        self.controller.now = lambda: now[0]
        self.sign_in()
        quote = self.controller.price("edit-frame", "x")
        now[0] += 11 * 60
        self.assertEqual(self.controller.create(quote["quote_id"])["kind"], "error")
        self.assertEqual(self.calls("edit_image"), [])


class BrowserPanelTests(unittest.TestCase):
    def test_only_answers_its_secret_path_on_loopback(self):
        panel = P.BrowserPanel(P.Controller(None, path=os.path.join(tempfile.mkdtemp(), "x.json")))
        thread = threading.Thread(target=panel.serve, kwargs={"open_page": False})
        thread.daemon = True
        thread.start()
        try:
            origin = panel.url.split("/", 3)
            root = "%s//%s" % (origin[0], origin[2])
            self.assertEqual(P.http("GET", root + "/").status, 404)
            self.assertEqual(P.http("GET", panel.url).status, 200)
            self.assertEqual(P.http("POST", panel.url + "api/state", {"content-type": "text/plain"}, b"{}").status, 404)
            reply = P.http("POST", panel.url + "api/state", {"content-type": "application/json"}, b"{}")
            self.assertEqual(reply.json(), {"signedIn": False, "balance": None})
            self.assertEqual(P.http("GET", panel.url, {"host": "evil.example"}).status, 404)
        finally:
            P.http("POST", panel.url + "api/close", {"content-type": "application/json"}, b"{}")
            thread.join(5)


class HelperTests(unittest.TestCase):
    def test_timecode(self):
        self.assertEqual(P.timecode_to_frames("01:00:00:00", 24), 86400)
        self.assertEqual(P.timecode_to_frames("00:01:00;02", 29.97), 1800)
        self.assertEqual(P.timecode_to_frames("00:10:00;00", 29.97), 17982)

    def test_outcome_classification(self):
        self.assertEqual(P.outcome_of({"content": [{"type": "text", "text": "x"}], "structuredContent": {"needs_consent": True}})["kind"], "needs_consent")
        self.assertEqual(P.outcome_of({"structuredContent": {"needs_confirmation": True, "credits": 300}})["kind"], "price_changed")
        self.assertEqual(P.outcome_of({"content": [{"type": "text", "text": "Not enough credits"}], "isError": True})["kind"], "not_enough")

    def test_no_api_key_or_usd_words_for_users(self):
        with open(os.path.join(HERE, "..", "PopNow.py"), encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotRegex(source, r"(?i)api[ _-]?key|\bUSD\b|sk-")

    def test_runs_on_python_36_syntax(self):
        with open(os.path.join(HERE, "..", "PopNow.py"), encoding="utf-8") as handle:
            source = handle.read()
        self.assertNotIn(":=", source)
        self.assertNotRegex(source, r"\bmatch \w+:")


if __name__ == "__main__":
    unittest.main()
