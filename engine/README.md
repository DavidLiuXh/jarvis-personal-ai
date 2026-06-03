# FORGE ENGINE

Local AI agent. No cloud. No API keys. No phone home.

## What it is

- Talks to **Ollama** running on your own hardware
- Jumps to next device automatically if primary goes down
- Stores conversation history in local **SQLite** (`memory.db`)
- Web UI served from the agent itself — no external server needed
- Single dependency: `requests` (for Ollama HTTP)
- Everything else is Python stdlib

## Start

```bash
# install
pip install requests

# pull a model (once)
ollama pull qwen2.5-coder:7b

# run interactive CLI
python agent.py

# run web server (then open http://localhost:7331)
python agent.py --server

# check which devices are reachable
python agent.py --devices

# ask a single question
python agent.py "what is a segfault"
```

## Configure

Edit `config.json`:
- `devices` — list your devices with their Ollama endpoints and priority order
- `model` — any model available in Ollama (`ollama list`)
- `system_prompt` — what the agent knows about itself
- `port` — web server port (default 7331)

## Device jumping

Agent checks devices in priority order before each request.
Health check is a 2-second ping to `/api/tags`.
If a device goes down mid-session, next request routes to the next one.

## Memory

Conversation history lives in `memory.db` (SQLite, auto-created).
Clear it: `python agent.py --wipe`
View it:  `python agent.py --history 20`

## Updates from cloud sessions

When you're in a Claude Code session, config can be updated by writing to `config.json`.
The agent reloads config on every request — no restart needed.
The agent itself never calls out.
