# Jarvis Python Runtime

This directory contains the Python implementation of the Jarvis runtime. It is
kept independent from the existing TypeScript runtime so the migration can be
incremental and behavior can be compared between both implementations.

## Layout

```text
python/
  src/jarvis_runtime/  Runtime package
  tests/               Unit and compatibility tests
  pyproject.toml       Python project and tool configuration
```

## Development

Python 3.11 or newer is required.

```bash
cd python
python -m venv .venv
source .venv/bin/activate
python -m pip install -e '.[dev]'
pytest
```

## Migration boundaries

The Python runtime will be introduced in stages:

1. Agent runtime context, lifecycle, and LLM loop.
2. Memory and session storage compatibility.
3. Intent resolution and TaskGraph planning/execution.
4. Tool routing, workspace permissions, and confirmations.
5. Channels, scheduling, and entrypoint cutover.

The existing TypeScript implementation remains the behavioral reference until
the corresponding Python stage passes compatibility gates.
