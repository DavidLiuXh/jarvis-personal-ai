#!/usr/bin/env python3
"""
FORGE ENGINE
------------
Local-only AI agent. No cloud. No API keys. No external dependencies.
Talks to Ollama on your own hardware. Jumps to next device if primary is down.
Memory stored in local SQLite. Nothing leaves your machine.

Usage:
  python agent.py                   # interactive CLI
  python agent.py "your question"   # single shot
  python agent.py --server          # start HTTP server (port from config)
  python agent.py --devices         # show device health
  python agent.py --history [n]     # show last n exchanges (default 10)
  python agent.py --wipe            # clear conversation history
"""

import json
import os
import sqlite3
import sys
import time
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

try:
    import requests
except ImportError:
    print("Missing: pip install requests")
    sys.exit(1)

DIR    = os.path.dirname(os.path.abspath(__file__))
CFG    = os.path.join(DIR, "config.json")
DB     = os.path.join(DIR, "memory.db")


# ── config ──────────────────────────────────────────────────────────────────

def load_cfg() -> dict:
    with open(CFG) as f:
        return json.load(f)


# ── memory (SQLite) ──────────────────────────────────────────────────────────

def get_db() -> sqlite3.Connection:
    con = sqlite3.connect(DB)
    con.execute("""
        CREATE TABLE IF NOT EXISTS history (
            id        INTEGER PRIMARY KEY AUTOINCREMENT,
            ts        TEXT    DEFAULT (datetime('now')),
            role      TEXT    NOT NULL,
            content   TEXT    NOT NULL,
            device    TEXT
        )
    """)
    con.execute("""
        CREATE TABLE IF NOT EXISTS facts (
            key   TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    con.commit()
    return con


def save_turn(role: str, content: str, device: str = None):
    con = get_db()
    con.execute("INSERT INTO history (role, content, device) VALUES (?,?,?)",
                (role, content, device))
    con.commit()
    con.close()


def get_history(n: int = 20) -> list[dict]:
    con = get_db()
    rows = con.execute(
        "SELECT role, content FROM history ORDER BY id DESC LIMIT ?", (n,)
    ).fetchall()
    con.close()
    return [{"role": r, "content": c} for r, c in reversed(rows)]


def wipe_history():
    con = get_db()
    con.execute("DELETE FROM history")
    con.commit()
    con.close()


# ── device routing ───────────────────────────────────────────────────────────

def find_device(cfg: dict) -> tuple:
    """Return (name, endpoint) of first healthy Ollama device."""
    devices = sorted(cfg.get("devices", []), key=lambda d: d.get("priority", 99))
    timeout = cfg.get("health_timeout", 2)
    for d in devices:
        try:
            r = requests.get(f"{d['endpoint']}/api/tags", timeout=timeout)
            if r.status_code == 200:
                return d["name"], d["endpoint"]
        except Exception:
            continue
    return None, None


def list_devices(cfg: dict):
    devices = sorted(cfg.get("devices", []), key=lambda d: d.get("priority", 99))
    timeout = cfg.get("health_timeout", 2)
    print("\nDEVICE STATUS")
    print("─" * 40)
    for d in devices:
        try:
            r = requests.get(f"{d['endpoint']}/api/tags", timeout=timeout)
            status = "ONLINE" if r.status_code == 200 else "ERROR"
        except Exception:
            status = "OFFLINE"
        mark = "●" if status == "ONLINE" else "○"
        print(f"  {mark} {d['name']:<12} {d['endpoint']:<32} {status}")
    print()


# ── inference ────────────────────────────────────────────────────────────────

def ask(prompt: str, cfg: dict, history: list = None) -> tuple:
    """Send prompt to best available device. Returns (response, device_name)."""
    name, endpoint = find_device(cfg)
    if not endpoint:
        return (
            "[OFFLINE] No Ollama device found.\n"
            "Start Ollama: ollama serve\n"
            f"Pull model:   ollama pull {cfg.get('model','qwen2.5-coder:7b')}",
            None
        )

    messages = [{"role": "system", "content": cfg["system_prompt"]}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": prompt})

    try:
        r = requests.post(
            f"{endpoint}/api/chat",
            json={"model": cfg["model"], "messages": messages, "stream": False},
            timeout=cfg.get("request_timeout", 120)
        )
        r.raise_for_status()
        return r.json()["message"]["content"], name
    except requests.exceptions.Timeout:
        return f"[TIMEOUT] {name} took too long. Try a smaller model.", name
    except Exception as e:
        return f"[ERROR] {e}", name


# ── CLI ──────────────────────────────────────────────────────────────────────

def run_cli():
    cfg = load_cfg()
    print(f"\n  FORGE ENGINE  |  model: {cfg['model']}  |  type 'exit' to quit\n")

    while True:
        try:
            prompt = input("you > ").strip()
        except (KeyboardInterrupt, EOFError):
            print("\nbye")
            break
        if not prompt:
            continue
        if prompt.lower() in ("exit", "quit", "q"):
            break

        save_turn("user", prompt)
        history = get_history(20)
        response, device = ask(prompt, cfg, history[:-1])  # exclude the one we just saved
        save_turn("assistant", response, device)

        tag = f" [{device}]" if device else ""
        print(f"\nagent{tag} > {response}\n")


# ── HTTP server ──────────────────────────────────────────────────────────────

def make_handler():
    cfg_ref = [load_cfg()]

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a): pass  # silence access log

        def send_json(self, code, data):
            body = json.dumps(data).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", len(body))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def send_file(self, path, mime):
            with open(path, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", mime)
            self.send_header("Content-Length", len(body))
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):
            p = urlparse(self.path).path
            if p in ("/", "/ui"):
                self.send_file(os.path.join(DIR, "ui.html"), "text/html")
            elif p == "/api/history":
                self.send_json(200, get_history(50))
            elif p == "/api/devices":
                cfg = cfg_ref[0]
                devices = sorted(cfg.get("devices", []), key=lambda d: d.get("priority", 99))
                timeout = cfg.get("health_timeout", 2)
                result = []
                for d in devices:
                    try:
                        r = requests.get(f"{d['endpoint']}/api/tags", timeout=timeout)
                        online = r.status_code == 200
                    except Exception:
                        online = False
                    result.append({**d, "online": online})
                self.send_json(200, result)
            else:
                self.send_json(404, {"error": "not found"})

        def do_POST(self):
            p = urlparse(self.path).path
            length = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(length)

            if p == "/api/ask":
                try:
                    data = json.loads(body)
                    prompt = data.get("prompt", "").strip()
                    if not prompt:
                        self.send_json(400, {"error": "empty prompt"})
                        return
                    cfg = load_cfg()          # reload on each request (live config updates)
                    cfg_ref[0] = cfg
                    save_turn("user", prompt)
                    history = get_history(20)
                    response, device = ask(prompt, cfg, history[:-1])
                    save_turn("assistant", response, device)
                    self.send_json(200, {"response": response, "device": device})
                except Exception as e:
                    self.send_json(500, {"error": str(e)})

            elif p == "/api/wipe":
                wipe_history()
                self.send_json(200, {"ok": True})

            elif p == "/api/reload":
                cfg_ref[0] = load_cfg()
                self.send_json(200, {"ok": True, "model": cfg_ref[0]["model"]})

            else:
                self.send_json(404, {"error": "not found"})

    return Handler


def run_server():
    cfg = load_cfg()
    port = cfg.get("port", 7331)
    server = HTTPServer(("0.0.0.0", port), make_handler())
    print(f"\n  FORGE ENGINE running on http://localhost:{port}")
    print(f"  model: {cfg['model']}  |  Ctrl+C to stop\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopped")


# ── entry ────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    args = sys.argv[1:]

    if not args:
        run_cli()
    elif args[0] == "--server":
        run_server()
    elif args[0] == "--devices":
        list_devices(load_cfg())
    elif args[0] == "--wipe":
        wipe_history()
        print("history cleared")
    elif args[0] == "--history":
        n = int(args[1]) if len(args) > 1 else 10
        for turn in get_history(n):
            print(f"\n[{turn['role']}]\n{turn['content']}")
    elif args[0] == "--reload":
        print(f"config loaded: {load_cfg()['model']}")
    else:
        # single-shot question from command line
        cfg = load_cfg()
        prompt = " ".join(args)
        save_turn("user", prompt)
        history = get_history(20)
        response, device = ask(prompt, cfg, history[:-1])
        save_turn("assistant", response, device)
        tag = f" [{device}]" if device else ""
        print(f"\n{response}\n")
