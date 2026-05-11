"""
Lightweight cross-encoder reranker service.
Uses ONNX Runtime for fast CPU inference with ms-marco-MiniLM-L6-v2.

POST /rerank
  Body: { "query": "...", "candidates": ["doc1", "doc2", ...] }
  Response: { "scores": [0.92, 0.13, ...] }   # same order as candidates

POST /rerank_sorted
  Body: { "query": "...", "candidates": ["doc1", "doc2", ...], "top_k": 5 }
  Response: { "results": [{"text": "doc1", "score": 0.92, "index": 0}, ...] }
"""

import onnxruntime as ort
from fastapi import FastAPI
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

app = FastAPI()
tokenizer = AutoTokenizer.from_pretrained(MODEL_DIR)
session = ort.InferenceSession(
    os.path.join(MODEL_DIR, "model.onnx"),
    providers=["CPUExecutionProvider"],
)


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
    pairs = [(query, doc) for doc in candidates]
    inputs = tokenizer(
        [p[0] for p in pairs],
        [p[1] for p in pairs],
        return_tensors="np",
        truncation=True,
        padding=True,
        max_length=MAX_LENGTH,
    )
    outputs = session.run(
        None,
        {
            "input_ids": inputs["input_ids"],
            "attention_mask": inputs["attention_mask"],
            "token_type_ids": inputs["token_type_ids"],
        },
    )
    # Raw logits — higher = more relevant
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
    top_k = req.top_k or len(ranked)
    return {"results": ranked[:top_k]}


if __name__ == "__main__":
    print(f"Starting reranker service on port {PORT}, model={MODEL_DIR}")
    uvicorn.run(app, host="0.0.0.0", port=PORT)
