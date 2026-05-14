#!/usr/bin/env bash
# Start the cross-encoder reranker service for Jarvis.
# Uses the onnx_env venv at ~/onnx_env.
#
# Usage:
#   ./start_reranker.sh                          # default port 7700
#   RERANKER_PORT=7701 ./start_reranker.sh
#   RERANKER_MODEL_DIR=/path/to/onnx_model ./start_reranker.sh
#
# First-time setup:
#   python3 -m venv ~/onnx_env
#   ~/onnx_env/bin/pip install onnxruntime transformers fastapi uvicorn optimum[onnxruntime]
#
#   # Option A: BAAI/bge-reranker-large (recommended — best multilingual accuracy, ~1.3GB)
#   ~/onnx_env/bin/python3 -c "
#     import os
#     from optimum.onnxruntime import ORTModelForSequenceClassification
#     from transformers import AutoTokenizer
#     model_id = 'BAAI/bge-reranker-large'
#     m = ORTModelForSequenceClassification.from_pretrained(model_id, export=True)
#     m.save_pretrained(os.path.expanduser('~/onnx_model'))
#     AutoTokenizer.from_pretrained(model_id).save_pretrained(os.path.expanduser('~/onnx_model'))
#   "
#
#   # Option A2: BAAI/bge-reranker-base (lighter — ~400MB, slightly lower accuracy)
#   ~/onnx_env/bin/python3 -c "
#     import os
#     from optimum.onnxruntime import ORTModelForSequenceClassification
#     from transformers import AutoTokenizer
#     model_id = 'BAAI/bge-reranker-base'
#     m = ORTModelForSequenceClassification.from_pretrained(model_id, export=True)
#     m.save_pretrained(os.path.expanduser('~/onnx_model'))
#     AutoTokenizer.from_pretrained(model_id).save_pretrained(os.path.expanduser('~/onnx_model'))
#   "
#
#   # Option B: cross-encoder/ms-marco-MiniLM-L6-v2 (English only, faster)
#   ~/onnx_env/bin/python3 -c "
#     import os
#     from optimum.onnxruntime import ORTModelForSequenceClassification
#     from transformers import AutoTokenizer
#     model_id = 'cross-encoder/ms-marco-MiniLM-L6-v2'
#     m = ORTModelForSequenceClassification.from_pretrained(model_id, export=True)
#     m.save_pretrained(os.path.expanduser('~/onnx_model'))
#     AutoTokenizer.from_pretrained(model_id).save_pretrained(os.path.expanduser('~/onnx_model'))
#   "
#
# Jarvis config to enable reranking (~/.gemini-jarvis/config.json):
#   "reranker": { "enabled": true, "baseUrl": "http://localhost:7700" }

set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_PYTHON="${HOME}/onnx_env/bin/python3"

if [[ ! -f "$VENV_PYTHON" ]]; then
  echo "❌ onnx_env not found at ${HOME}/onnx_env"
  echo "   See setup instructions at the top of this script."
  exit 1
fi

# Default model dir: ~/onnx_model (can override via env var)
export RERANKER_MODEL_DIR="${RERANKER_MODEL_DIR:-${HOME}/onnx_model}"
export RERANKER_PORT="${RERANKER_PORT:-7700}"

if [[ ! -f "${RERANKER_MODEL_DIR}/model.onnx" ]]; then
  echo "❌ ONNX model not found at ${RERANKER_MODEL_DIR}/model.onnx"
  echo "   Set RERANKER_MODEL_DIR to the directory containing model.onnx"
  exit 1
fi

echo "🚀 Starting reranker service (model=${RERANKER_MODEL_DIR}, port=${RERANKER_PORT})"
exec "$VENV_PYTHON" "${SCRIPT_DIR}/reranker_service.py"
