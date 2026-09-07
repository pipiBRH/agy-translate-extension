#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Automated offline regression tests for agy-translate-extension server security.
Covers:
1. Concurrency & atomic race condition protection on pairing redemption.
2. Atomic brute-force attempt lockout (max 5 attempts).
3. Replay attacks and session expiration.
4. Domain-separated anti-relay service proof (binding actual listening port and paired origin).
5. Route authentication, Origin: null rejection, and unauthorized origin prevention.
6. Cache TTL enforcement on read and safe cache sweeping.
"""

import concurrent.futures
import hashlib
import hmac
import http.client
import json
import os
import secrets
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
from unittest import mock
import urllib.parse

# Ensure server module can be imported
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server"))
import server


def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class SecurityServerTests(unittest.TestCase):
    def test_legacy_workflow_discovery_uses_generic_namespace(self):
        with tempfile.TemporaryDirectory(prefix="agy-workflow-discovery-") as root:
            data = os.path.join(root, "Library/Application Support/Alfred/Workflow Data/example.agy.translate")
            cache = os.path.join(root, "Library/Caches/com.runningwithcrayons.Alfred/Workflow Data/example.agy.translate")
            os.makedirs(data)
            os.makedirs(cache)
            with open(os.path.join(data, "oauth.json"), "w", encoding="utf-8") as fixture:
                fixture.write("{}")  # Synthetic presence marker; no real credential.
            with mock.patch.dict(os.environ, {"alfred_workflow_data": "", "alfred_workflow_cache": ""}), \
                    mock.patch.object(server.os.path, "expanduser", side_effect=lambda path: path.replace("~", root, 1)):
                self.assertEqual(server._resolve_data_dir(), data)
                self.assertEqual(server._resolve_cache_dir(), cache)

    @classmethod
    def setUpClass(cls):
        cls.test_dir = tempfile.mkdtemp(prefix="agy_test_")
        cls.orig_data_dir = server.DATA_DIR
        cls.orig_cache_dir = server.CACHE_DIR
        cls.orig_pairing_lock = server.PAIRING_LOCK_FILE
        cls.orig_clients_lock = server.CLIENTS_LOCK_FILE
        cls.orig_paired_clients = server.PAIRED_CLIENTS_FILE
        cls.orig_pairing_code = server.PAIRING_CODE_FILE
        cls.orig_token_file = server.TOKEN_FILE
        cls.orig_token_lock = server.TOKEN_LOCK

        server.DATA_DIR = os.path.join(cls.test_dir, "data")
        server.CACHE_DIR = os.path.join(cls.test_dir, "cache")
        server.PAIRING_LOCK_FILE = os.path.join(server.DATA_DIR, ".pairing.lock")
        server.CLIENTS_LOCK_FILE = os.path.join(server.DATA_DIR, ".clients.lock")
        server.PAIRED_CLIENTS_FILE = os.path.join(server.DATA_DIR, "paired_clients.json")
        server.PAIRING_CODE_FILE = os.path.join(server.DATA_DIR, "pairing_code.json")
        server.TOKEN_FILE = os.path.join(server.DATA_DIR, "oauth.json")
        server.TOKEN_LOCK = os.path.join(server.DATA_DIR, "oauth.lock")
        server.ensure_cache()

        # Start background test HTTP server
        cls.port = find_free_port()
        cls.httpd = server.Server(("127.0.0.1", cls.port), server.Handler)
        cls.server_thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.server_thread.start()
        time.sleep(0.1)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.httpd.shutdown()
            cls.httpd.server_close()
        except Exception:
            pass
        server.DATA_DIR = cls.orig_data_dir
        server.CACHE_DIR = cls.orig_cache_dir
        server.PAIRING_LOCK_FILE = cls.orig_pairing_lock
        server.CLIENTS_LOCK_FILE = cls.orig_clients_lock
        server.PAIRED_CLIENTS_FILE = cls.orig_paired_clients
        server.PAIRING_CODE_FILE = cls.orig_pairing_code
        server.TOKEN_FILE = cls.orig_token_file
        server.TOKEN_LOCK = cls.orig_token_lock
        shutil.rmtree(cls.test_dir, ignore_errors=True)

    def setUp(self):
        server.ensure_cache()
        server._secret_cache["v"] = None
        server._file_locks.clear()
        # Clear pairing and client files
        for f in (server.PAIRING_CODE_FILE, server.PAIRED_CLIENTS_FILE):
            if os.path.exists(f):
                try:
                    os.remove(f)
                except OSError:
                    pass

    # -------------------------------------------------------------
    # Test 1: Concurrency & Atomic Race Conditions on Pairing
    # -------------------------------------------------------------
    def test_concurrent_pairing_redemption_race(self):
        """Verify that under concurrent redemption requests, exactly one succeeds and all others fail."""
        code, _ = server.generate_pairing_code()
        origin = "chrome-extension://abcdefghijklmnop"
        client_nonce = secrets.token_hex(16)
        server_nonce, _ = server.init_pairing_session(client_nonce, origin, self.port)

        domain_sep = "agy-pair-client-redeem-v1"
        msg = f"{domain_sep}:{self.port}:{origin}:{client_nonce}:{server_nonce}"
        client_proof = hmac.new(code.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()

        num_racers = 10
        results = []

        def attempt_redeem():
            try:
                res = server.redeem_pairing_proof(client_nonce, server_nonce, client_proof, origin, self.port)
                return ("success", res)
            except ValueError as e:
                return ("failed", str(e))

        with concurrent.futures.ThreadPoolExecutor(max_workers=num_racers) as executor:
            futures = [executor.submit(attempt_redeem) for _ in range(num_racers)]
            for fut in concurrent.futures.as_completed(futures):
                results.append(fut.result())

        successes = [r for r in results if r[0] == "success"]
        failures = [r for r in results if r[0] == "failed"]

        self.assertEqual(len(successes), 1, "Exactly one concurrent request must succeed in pairing redemption")
        self.assertEqual(len(failures), num_racers - 1, "All other racing requests must be rejected")
        self.assertFalse(os.path.exists(server.PAIRING_CODE_FILE), "Pairing code must be burned immediately upon redemption")

    def test_atomic_pairing_attempt_limit(self):
        """Verify that 5 failed attempts atomically locks the session and clears pairing file."""
        code, _ = server.generate_pairing_code()
        origin = "chrome-extension://abcdefghijklmnop"
        client_nonce = secrets.token_hex(16)
        server_nonce, _ = server.init_pairing_session(client_nonce, origin, self.port)

        # 4 invalid attempts
        for i in range(4):
            with self.assertRaises(ValueError) as cm:
                server.redeem_pairing_proof(client_nonce, server_nonce, "invalidproof", origin, self.port)
            self.assertIn("Invalid pairing proof", str(cm.exception))
            self.assertTrue(os.path.exists(server.PAIRING_CODE_FILE))

        # 5th invalid attempt must lock and delete
        with self.assertRaises(ValueError) as cm:
            server.redeem_pairing_proof(client_nonce, server_nonce, "invalidproof", origin, self.port)
        self.assertIn("Too many failed pairing attempts", str(cm.exception))
        self.assertFalse(os.path.exists(server.PAIRING_CODE_FILE), "Session must be locked and pairing file deleted on 5th failure")

    def test_pairing_code_expiration(self):
        """Verify that expired pairing codes are rejected and removed."""
        code, _ = server.generate_pairing_code()
        origin = "chrome-extension://abcdefghijklmnop"
        client_nonce = secrets.token_hex(16)
        server_nonce, _ = server.init_pairing_session(client_nonce, origin, self.port)

        # Manually expire the session
        with open(server.PAIRING_CODE_FILE, "r", encoding="utf-8") as f:
            st = json.load(f)
        st["expires_at"] = time.time() - 10
        server.write_private(server.PAIRING_CODE_FILE, json.dumps(st))

        domain_sep = "agy-pair-client-redeem-v1"
        msg = f"{domain_sep}:{self.port}:{origin}:{client_nonce}:{server_nonce}"
        client_proof = hmac.new(code.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()

        with self.assertRaises(ValueError) as cm:
            server.redeem_pairing_proof(client_nonce, server_nonce, client_proof, origin, self.port)
        self.assertIn("expired", str(cm.exception).lower())
        self.assertFalse(os.path.exists(server.PAIRING_CODE_FILE))

    # -------------------------------------------------------------
    # Test 2: Service Proof Anti-Relay & Fake Listener Prevention
    # -------------------------------------------------------------
    def test_service_proof_port_and_origin_binding(self):
        """Verify that service proof binds port, origin, and nonce."""
        code, _ = server.generate_pairing_code()
        origin = "chrome-extension://testextensionid"
        client_nonce = secrets.token_hex(16)
        server_nonce, _ = server.init_pairing_session(client_nonce, origin, self.port)

        domain_sep = "agy-pair-client-redeem-v1"
        msg = f"{domain_sep}:{self.port}:{origin}:{client_nonce}:{server_nonce}"
        client_proof = hmac.new(code.encode("utf-8"), msg.encode("utf-8"), hashlib.sha256).hexdigest()
        creds = server.redeem_pairing_proof(client_nonce, server_nonce, client_proof, origin, self.port)

        client_id = creds["client_id"]
        secret = creds["secret"]
        nonce = secrets.token_hex(16)

        # Genuine proof generated on self.port
        proof = server.get_service_proof(client_id, nonce, origin, self.port)
        self.assertIsNotNone(proof)

        # Verify against client expectation on self.port
        expected = hmac.new(secret.encode("utf-8"),
                            f"agy-service-proof-v1:{self.port}:{origin}:{nonce}".encode("utf-8"),
                            hashlib.sha256).hexdigest()
        self.assertEqual(proof, expected)

        # Extension GET requests can omit Origin. The proof must retain the
        # paired origin binding, while explicit null/wrong origins stay denied.
        self.assertEqual(server.get_service_proof(client_id, nonce, "", self.port), expected)
        self.assertIsNone(server.get_service_proof(client_id, nonce, "null", self.port))
        status, _, data = self._http_request(
            "GET", f"/api/auth/verify?client_id={client_id}&nonce={nonce}")
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(data)["proof"], expected)

        # Anti-Relay Test: If a fake listener on port 47822 relays to genuine daemon on self.port:
        fake_listener_port = self.port + 1
        client_verifies_against_fake_port = hmac.new(
            secret.encode("utf-8"),
            f"agy-service-proof-v1:{fake_listener_port}:{origin}:{nonce}".encode("utf-8"),
            hashlib.sha256).hexdigest()
        self.assertNotEqual(proof, client_verifies_against_fake_port,
                            "Service proof computed on genuine port must NOT match verification for fake port")

        # Origin Mismatch Test: attacker tries to get proof for another origin
        evil_origin = "chrome-extension://evilattackerid"
        evil_proof = server.get_service_proof(client_id, nonce, evil_origin, self.port)
        self.assertIsNone(evil_proof, "Service proof must be refused if origin does not match paired client origin")

    # -------------------------------------------------------------
    # Test 3: HTTP Route Authentication & Origin Enforcement
    # -------------------------------------------------------------
    def _http_request(self, method, path, headers=None, body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        headers = headers or {}
        conn.request(method, path, body=body, headers=headers)
        resp = conn.getresponse()
        data = resp.read().decode("utf-8")
        conn.close()
        return resp.status, resp.headers, data

    def test_http_route_auth_and_origin_null_rejection(self):
        """Verify that /api/translate rejects unauthenticated calls and Origin: null."""
        # Missing token from CLI (no Origin) -> 401 Unauthorized
        status, headers, data = self._http_request(
            "POST", "/api/translate",
            headers={"Content-Type": "application/json"},
            body=json.dumps({"text": "Hello"})
        )
        self.assertEqual(status, 401)

        # Unpaired extension origin on protected route -> 403 Forbidden
        status, headers, data = self._http_request(
            "POST", "/api/translate",
            headers={"Content-Type": "application/json", "Origin": "chrome-extension://unpairedid"},
            body=json.dumps({"text": "Hello"})
        )
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", str(headers))

        # Origin null -> 403 Forbidden
        status, headers, data = self._http_request(
            "POST", "/api/translate",
            headers={"Content-Type": "application/json", "Origin": "null", "Authorization": "Bearer anytoken"},
            body=json.dumps({"text": "Hello"})
        )
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", str(headers))

        # Unauthorized web origin (e.g. evil.com) -> 403
        status, headers, data = self._http_request(
            "POST", "/api/translate",
            headers={"Content-Type": "application/json", "Origin": "https://evil.com", "Authorization": "Bearer anytoken"},
            body=json.dumps({"text": "Hello"})
        )
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", str(headers))

    def test_http_pairing_and_authenticated_request(self):
        """Full HTTP flow: /api/pair/init -> /api/pair/redeem -> /api/auth/verify -> authenticated translate."""
        code, _ = server.generate_pairing_code()
        origin = "chrome-extension://legitclient123"
        client_nonce = secrets.token_hex(16)

        # 1. /api/pair/init
        status, headers, data = self._http_request(
            "POST", "/api/pair/init",
            headers={"Content-Type": "application/json", "Origin": origin},
            body=json.dumps({"client_nonce": client_nonce})
        )
        self.assertEqual(status, 200)
        init_res = json.loads(data)
        server_nonce = init_res["server_nonce"]
        server_proof = init_res["server_proof"]

        # Verify server proof on client
        expected_server_proof = hmac.new(
            code.encode("utf-8"),
            f"agy-pair-server-proof-v1:{self.port}:{origin}:{client_nonce}:{server_nonce}".encode("utf-8"),
            hashlib.sha256).hexdigest()
        self.assertEqual(server_proof, expected_server_proof)

        # 2. /api/pair/redeem
        client_proof = hmac.new(
            code.encode("utf-8"),
            f"agy-pair-client-redeem-v1:{self.port}:{origin}:{client_nonce}:{server_nonce}".encode("utf-8"),
            hashlib.sha256).hexdigest()
        status, headers, data = self._http_request(
            "POST", "/api/pair/redeem",
            headers={"Content-Type": "application/json", "Origin": origin},
            body=json.dumps({"client_nonce": client_nonce, "server_nonce": server_nonce, "client_proof": client_proof})
        )
        self.assertEqual(status, 200)
        redeem_res = json.loads(data)
        self.assertEqual(redeem_res["status"], "paired")
        token = redeem_res["token"]
        secret = redeem_res["secret"]
        client_id = redeem_res["client_id"]

        # 3. /api/auth/verify
        v_nonce = secrets.token_hex(16)
        status, headers, data = self._http_request(
            "GET", f"/api/auth/verify?client_id={client_id}&nonce={v_nonce}",
            headers={"Origin": origin}
        )
        self.assertEqual(status, 200)
        v_res = json.loads(data)
        expected_v_proof = hmac.new(
            secret.encode("utf-8"),
            f"agy-service-proof-v1:{self.port}:{origin}:{v_nonce}".encode("utf-8"),
            hashlib.sha256).hexdigest()
        self.assertEqual(v_res["proof"], expected_v_proof)

        # 4. Authenticated request with wrong origin -> 403 Forbidden
        wrong_origin = "chrome-extension://wrongorigin"
        status, headers, data = self._http_request(
            "POST", "/api/translate",
            headers={"Content-Type": "application/json", "Origin": wrong_origin, "Authorization": f"Bearer {token}"},
            body=json.dumps({"text": "Hello"})
        )
        self.assertEqual(status, 403)

    # -------------------------------------------------------------
    # Test 4: Cache TTL & Cache Management
    # -------------------------------------------------------------
    def test_cache_ttl_and_safe_clearing(self):
        """Verify that cache TTL is strictly enforced and clear_cache preserves credentials."""
        # Create a fresh cache result
        key1 = "1234567890abcdef"
        p1 = server.paths(key1)
        fresh_data = {"ts": time.time(), "primary": {"text": "hello"}}
        server.write_private(p1["result"], json.dumps(fresh_data))
        self.assertTrue(server.is_cache_valid(p1["result"], ttl=60))

        # Create an expired cache result
        key2 = "abcdef1234567890"
        p2 = server.paths(key2)
        expired_data = {"ts": time.time() - 100, "primary": {"text": "old"}}
        server.write_private(p2["result"], json.dumps(expired_data))
        self.assertFalse(server.is_cache_valid(p2["result"], ttl=60), "Expired cache must return False")
        self.assertFalse(os.path.exists(p2["result"]), "Expired cache must be removed on read")

        # Create server secret and paired clients files
        secret_file = os.path.join(server.CACHE_DIR, "server_secret")
        server.write_private(secret_file, "supersecretstring12345678901234")

        # Call clear_cache
        cleared = server.clear_cache()
        self.assertGreaterEqual(cleared, 1)
        self.assertFalse(os.path.exists(p1["result"]), "Translation cache file must be deleted")
        self.assertTrue(os.path.exists(secret_file), "Server secret must NEVER be deleted by clear_cache")

    def test_cross_client_unpair_isolation(self):
        """Verify that client A cannot revoke client B, and master credential can unpair any client."""
        # Pair client A
        code_a, _ = server.generate_pairing_code()
        origin_a = "chrome-extension://clientaaaaaaaaaa"
        nonce_a = secrets.token_hex(16)
        s_nonce_a, _ = server.init_pairing_session(nonce_a, origin_a, self.port)
        proof_a = hmac.new(code_a.encode(), f"agy-pair-client-redeem-v1:{self.port}:{origin_a}:{nonce_a}:{s_nonce_a}".encode(), hashlib.sha256).hexdigest()
        creds_a = server.redeem_pairing_proof(nonce_a, s_nonce_a, proof_a, origin_a, self.port)

        # Pair client B
        code_b, _ = server.generate_pairing_code()
        origin_b = "chrome-extension://clientbbbbbbbbbb"
        nonce_b = secrets.token_hex(16)
        s_nonce_b, _ = server.init_pairing_session(nonce_b, origin_b, self.port)
        proof_b = hmac.new(code_b.encode(), f"agy-pair-client-redeem-v1:{self.port}:{origin_b}:{nonce_b}:{s_nonce_b}".encode(), hashlib.sha256).hexdigest()
        creds_b = server.redeem_pairing_proof(nonce_b, s_nonce_b, proof_b, origin_b, self.port)

        # Client A tries to unpair Client B -> 403 Cross-client unpair forbidden
        status, _, data = self._http_request(
            "POST", "/api/auth/unpair",
            headers={"Content-Type": "application/json", "Origin": origin_a, "Authorization": f"Bearer {creds_a['token']}"},
            body=json.dumps({"client_id": creds_b["client_id"]})
        )
        self.assertEqual(status, 403)
        self.assertIn("Cross-client unpair forbidden", data)

        # Client B must still be paired
        self.assertIsNotNone(server.get_paired_client(creds_b["client_id"]))

        # Client A unpairs itself -> 200 OK
        status, _, data = self._http_request(
            "POST", "/api/auth/unpair",
            headers={"Content-Type": "application/json", "Origin": origin_a, "Authorization": f"Bearer {creds_a['token']}"},
            body=json.dumps({})
        )
        self.assertEqual(status, 200)
        self.assertIsNone(server.get_paired_client(creds_a["client_id"]))
        self.assertIsNotNone(server.get_paired_client(creds_b["client_id"]))

        # Master server secret can unpair Client B
        master_secret = server.server_secret()
        status, _, data = self._http_request(
            "POST", "/api/auth/unpair",
            headers={"Content-Type": "application/json", "Authorization": f"Bearer {master_secret}"},
            body=json.dumps({"client_id": creds_b["client_id"]})
        )
        self.assertEqual(status, 200)
        self.assertIsNone(server.get_paired_client(creds_b["client_id"]))

    def test_no_cache_skips_disk_write(self):
        """Verify that no_cache=True prevents writing translation cache files to disk."""
        orig_logged_in = server.logged_in
        orig_access_token = server.access_token
        orig_post_api = server.post_api
        orig_extract_text = server.extract_text
        try:
            server.logged_in = lambda: True
            server.access_token = lambda: {"access": "mock-token", "project": "mock-project"}
            server.post_api = lambda path, tok, body, **kw: '{"candidates": [{"content": {"parts": [{"text": "**翻譯**\\nmock translation"}]}}]}'
            server.extract_text = lambda data: "**翻譯**\\nmock translation"

            # Pair client
            code, _ = server.generate_pairing_code()
            origin = "chrome-extension://cachetestclient"
            nonce = secrets.token_hex(16)
            s_nonce, _ = server.init_pairing_session(nonce, origin, self.port)
            proof = hmac.new(code.encode(), f"agy-pair-client-redeem-v1:{self.port}:{origin}:{nonce}:{s_nonce}".encode(), hashlib.sha256).hexdigest()
            creds = server.redeem_pairing_proof(nonce, s_nonce, proof, origin, self.port)

            cache_files_before = [f for f in os.listdir(server.CACHE_DIR) if f.endswith(".json")]

            # Send request with no_cache=True
            status, _, data = self._http_request(
                "POST", "/api/translate",
                headers={"Content-Type": "application/json", "Origin": origin, "Authorization": f"Bearer {creds['token']}"},
                body=json.dumps({"text": "unique test phrase for no_cache", "target_lang": "zh-TW", "no_cache": True})
            )
            self.assertEqual(status, 200)
            res = json.loads(data)
            self.assertEqual(res["status"], "done")

            cache_files_after = [f for f in os.listdir(server.CACHE_DIR) if f.endswith(".json")]
            self.assertEqual(len(cache_files_before), len(cache_files_after), "no_cache must not write any cache files to disk")
        finally:
            server.logged_in = orig_logged_in
            server.access_token = orig_access_token
            server.post_api = orig_post_api
            server.extract_text = orig_extract_text

    def test_input_validation_and_malformed_requests(self):
        """Verify handling of invalid Content-Length headers and malformed JSON payloads."""
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        try:
            # 1. Missing Content-Length -> 400
            conn.putrequest("POST", "/api/translate")
            conn.putheader("Host", f"127.0.0.1:{self.port}")
            conn.endheaders()
            resp = conn.getresponse()
            self.assertEqual(resp.status, 400)
            resp.read()
        finally:
            conn.close()

        # 2. Negative Content-Length -> 400
        status, _, _ = self._http_request("POST", "/api/translate", headers={"Content-Length": "-10"}, body=b"test")
        self.assertEqual(status, 400)

        # 3. Non-numeric Content-Length -> 400
        status, _, _ = self._http_request("POST", "/api/translate", headers={"Content-Length": "notanumber"}, body=b"test")
        self.assertEqual(status, 400)

        # 4. Malformed JSON -> 400
        status, _, data = self._http_request("POST", "/api/translate", headers={"Content-Type": "application/json"}, body=b"not json at all")
        self.assertEqual(status, 400)
        self.assertIn("Invalid JSON body", data)

        # 5. Non-object JSON body (e.g. array) -> 400
        status, _, data = self._http_request("POST", "/api/translate", headers={"Content-Type": "application/json"}, body=b'["array", "body"]')
        self.assertEqual(status, 400)
        self.assertIn("JSON body must be an object", data)

    def test_periodic_cache_cleanup_hook(self):
        """Verify that sweep_cache removes expired cache files and preserves credentials."""
        # Fresh cache file
        p_fresh = server.paths("1111222233334444")
        server.write_private(p_fresh["result"], json.dumps({"ts": time.time(), "primary": {"text": "fresh"}}))

        # Expired cache file (>24h old)
        p_expired = server.paths("aaaabbbbccccdddd")
        server.write_private(p_expired["result"], json.dumps({"ts": time.time() - 90000, "primary": {"text": "expired"}}))
        os.utime(p_expired["result"], (time.time() - 90000, time.time() - 90000))

        # Critical credential files
        secret_file = os.path.join(server.CACHE_DIR, "server_secret")
        server.write_private(secret_file, "secret-credential-value")

        # Invoke server sweep
        removed = server.sweep_cache(ttl=60)
        self.assertGreaterEqual(removed, 1)
        self.assertFalse(os.path.exists(p_expired["result"]), "Expired cache file must be removed by sweep")
        self.assertTrue(os.path.exists(p_fresh["result"]), "Fresh cache file must be preserved")
        self.assertTrue(os.path.exists(secret_file), "Server secret credential must NEVER be removed by sweep")

    def test_serve_forever_runs_periodic_cleanup_without_translation_requests(self):
        expired = server.paths("0123456789abcdef")["result"]
        server.write_private(expired, json.dumps({"primary": {"text": "synthetic expired result"}}))
        old = time.time() - server.CACHE_TTL - 60
        os.utime(expired, (old, old))
        unrelated = os.path.join(server.CACHE_DIR, "review-unrelated.txt")
        server.write_private(unrelated, "keep this file")
        with server.Server(("127.0.0.1", 0), server.Handler, sweep_interval=0.01) as httpd:
            worker = threading.Thread(target=lambda: httpd.serve_forever(poll_interval=0.01), daemon=True)
            worker.start()
            try:
                deadline = time.monotonic() + 2
                while os.path.exists(expired) and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertFalse(os.path.exists(expired))
                self.assertTrue(os.path.exists(unrelated))
            finally:
                httpd.shutdown()
                worker.join(timeout=2)

    def test_bootstrap_endpoints_reject_http_localhost(self):
        """Verify that /api/pair/init and /api/pair/redeem strictly reject http/https origins."""
        client_nonce = secrets.token_hex(16)

        # http://localhost:3000 -> 403
        status, headers, data = self._http_request(
            "POST", "/api/pair/init",
            headers={"Content-Type": "application/json", "Origin": "http://localhost:3000"},
            body=json.dumps({"client_nonce": client_nonce})
        )
        self.assertEqual(status, 403)
        self.assertNotIn("Access-Control-Allow-Origin", str(headers))

        # http://127.0.0.1:8080 -> 403
        status, headers, data = self._http_request(
            "POST", "/api/pair/init",
            headers={"Content-Type": "application/json", "Origin": "http://127.0.0.1:8080"},
            body=json.dumps({"client_nonce": client_nonce})
        )
        self.assertEqual(status, 403)

        # OPTIONS /api/pair/init with http origin -> 403 with Content-Length: 0
        status, headers, data = self._http_request(
            "OPTIONS", "/api/pair/init",
            headers={"Origin": "http://localhost:3000"}
        )
        self.assertEqual(status, 403)
        self.assertEqual(headers.get("Content-Length"), "0")


if __name__ == "__main__":
    unittest.main()
