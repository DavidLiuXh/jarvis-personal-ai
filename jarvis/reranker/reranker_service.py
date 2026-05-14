"""
Lightweight cross-encoder reranker service.
Uses ONNX Runtime for fast CPU inference with any ONNX sequence-classification
cross-encoder model (e.g. BAAI/bge-reranker-large, BAAI/bge-reranker-base).

POST /rerank
  Body: { "query": "...", "candidates": ["doc1", "doc2", ...] }
  Response: { "scores": [0.92, 0.13, ...] }   # same order as candidates

POST /rerank_sorted
  Body: { "query": "...", "candidates": ["doc1", "doc2", ...], "top_k": 5 }
  Response: { "results": [{"text": "doc1", "score": 0.92, "index": 0}, ...] }
"""

import onnxruntime as ort
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
from transformers import AutoTokenizer
from typing import Optional
import uvicorn
import os

MODEL_DIR = os.environ.get(
    "RERANKER_MODEL_DIR",
    os.path.expanduser("~/onnx_model"),
)
PORT = int(os.environ.get("RERANKER_PORT", "7700"))
MAX_LENGTH = 256
MAX_CANDIDATES = int(os.environ.get("RERANKER_MAX_CANDIDATES", "100"))

# Startup validation — fail fast with a clear message
if not os.path.isdir(MODEL_DIR):
    raise RuntimeError(f"RERANKER_MODEL_DIR not found: {MODEL_DIR!r}")
if not os.path.isfile(os.path.join(MODEL_DIR, "model.onnx")):
    raise RuntimeError(f"model.onnx not found in {MODEL_DIR!r}")

app = FastAPI()
tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
session = ort.InferenceSession(
    os.path.join(MODEL_DIR, "model.onnx"),
    providers=["CPUExecutionProvider"],
)
# Determine required input names from the model (handles both BERT and RoBERTa)
_input_names = {inp.name for inp in session.get_inputs()}


class RerankRequest(BaseModel):
    query: str
    candidates: list[str]


class RerankSortedRequest(BaseModel):
    query: str
    candidates: list[str]
    top_k: Optional[int] = None


def score_pairs(query: str, candidates: list[str]) -> list[float]:
    if not candidates:
        return []
    if len(candidates) > MAX_CANDIDATES:
        raise HTTPException(
            status_code=400,
            detail=f"Too many candidates: {len(candidates)} > {MAX_CANDIDATES}",
        )
    inputs = tokenizer(
        [query] * len(candidates),
        candidates,
        return_tensors="np",
        truncation=True,
        padding=True,
        max_length=MAX_LENGTH,
    )
    # Only pass inputs the model actually expects (BERT has token_type_ids, RoBERTa doesn't)
    feed = {k: inputs[k] for k in _input_names if k in inputs}
    outputs = session.run(None, feed)
    # outputs[0] shape: [batch_size, 1] — raw logit, higher = more relevant
    scores = outputs[0][:, 0].tolist()
    return scores


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/rerank")
def rerank(req: RerankRequest):
    scores = score_pairs(req.query, req.candidates)
    return {"scores": scores}


@app.post("/rerank_sorted")
def rerank_sorted(req: RerankSortedRequest):
    scores = score_pairs(req.query, req.candidates)
    ranked = sorted(
        [{"text": doc, "score": scores[i], "index": i} for i, doc in enumerate(req.candidates)],
        key=lambda x: x["score"],
        reverse=True,
    )
    top_k = req.top_k if req.top_k is not None else len(ranked)
    return {"results": ranked[:top_k]}


if __name__ == "__main__":
    print(f"Starting reranker service on port {PORT}, model={MODEL_DIR}")
    uvicorn.run(app, host="127.0.0.1", port=PORT)
