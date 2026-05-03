import os
import socket
import subprocess
import time
import json
import httpx
import sys

def find_free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]

PORT = find_free_port()

# Monkey patch agent.json temporarily for testing
with open("agent.json", "r") as f:
    original_card = json.load(f)

test_card = original_card.copy()
# The critical property V2 might be looking for
test_card["supportedOutputModes"] = ["text/plain", "STREAMING"]

with open("agent_test.json", "w") as f:
    json.dump(test_card, f)

# Patch main.py to read agent_test.json instead
with open("main.py", "r") as f:
    main_code = f.read()
patched_main = main_code.replace('with open(agent_json_path, "r") as f:', 'with open(os.path.join(base_dir, "agent_test.json"), "r") as f:')
with open("main_test.py", "w") as f:
    f.write(patched_main)

print(f"🚀 [Debug E2E] Starting Server on port {PORT}...")
env = os.environ.copy()
env["JARVIS_AGENT_PORT"] = str(PORT)
server_proc = subprocess.Popen(
    [sys.executable, "main_test.py"],
    env=env,
    stdout=sys.stdout,
    stderr=sys.stderr
)

time.sleep(3)

print("📡 [Client] Sending SendStreamingMessage request...")
url = f"http://127.0.0.1:{PORT}/"
payload = {
    "jsonrpc": "2.0",
    "id": "test-e2e-2",
    # Using the method name that triggered the "Streaming not supported" error
    "method": "SendStreamingMessage", 
    "params": {
        "message": {
            "role": "ROLE_USER",
            "parts": [{"text": "NVDA"}],
            "message_id": "m1"
        },
        "configuration": {"acceptedOutputModes": ["text/plain"]}
    }
}
headers = {
    "Content-Type": "application/json",
    "Accept": "text/event-stream",
    "A2A-Version": "1.0"
}

success = False
try:
    with httpx.stream("POST", url, json=payload, headers=headers, timeout=15.0) as r:
        print(f"Status Code: {r.status_code}")
        if r.status_code == 200:
            for line in r.iter_lines():
                if line.strip():
                    print(f"📥 [Raw SSE] {line}")
                    if '"error"' in line:
                        print("❌ Found ERROR in SSE stream.")
                        break
                    if '"artifactUpdate"' in line or '"statusUpdate"' in line:
                        print("✨ TRUE SUCCESS! Stream is working.")
                        success = True
                        break
except Exception as e:
    print(f"❌ [Client] Stream failed: {e}")

print("🛑 [Debug E2E] Shutting down...")
server_proc.terminate()
os.remove("agent_test.json")
os.remove("main_test.py")

if not success:
    sys.exit(1)
