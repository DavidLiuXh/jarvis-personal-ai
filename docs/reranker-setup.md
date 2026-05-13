# Reranker Setup Guide

Jarvis 使用本地 cross-encoder 模型（BAAI/bge-reranker-large）对记忆检索结果做精排，
显著提升中英文跨语言查询的召回准确率。

---

## 原理

```
vec_memories / vec_facts
  ↓ bi-encoder KNN (bge-m3)
  候选池 (最多 20 条)
  ↓ cross-encoder 精排 (bge-reranker-large)
  top-K 注入 prompt
```

精排服务是一个独立的 FastAPI 进程，通过 HTTP 与 Jarvis 通信，服务不可用时自动降级到 bi-encoder 排序。

---

## 部署步骤

### 1. 安装 Python 依赖

```bash
# 创建 venv（start_reranker.sh 默认从 ~/onnx_env 读取）
python3 -m venv ~/onnx_env

~/onnx_env/bin/pip install onnxruntime transformers fastapi uvicorn "optimum[onnxruntime]"
```

### 2. 导出 ONNX 模型

模型约 1.3GB，需要联网下载，**只需执行一次**。

```bash
~/onnx_env/bin/python3 - << 'EOF'
from optimum.onnxruntime import ORTModelForSequenceClassification
from transformers import AutoTokenizer
import os

model_id = "BAAI/bge-reranker-large"
output_dir = os.path.expanduser("~/onnx_model")

print(f"Exporting {model_id} → {output_dir} ...")
model = ORTModelForSequenceClassification.from_pretrained(model_id, export=True)
tokenizer = AutoTokenizer.from_pretrained(model_id)
model.save_pretrained(output_dir)
tokenizer.save_pretrained(output_dir)
print("Done.")
EOF
```

> **换机器时**：直接把 `~/onnx_model/` 目录打包复制，无需重新下载。

### 3. 启动服务

```bash
# 使用项目内的启动脚本
./jarvis/reranker/start_reranker.sh

# 验证
curl http://localhost:7700/health
# → {"status":"ok"}
```

自定义端口或模型路径：

```bash
RERANKER_PORT=7701 \
RERANKER_MODEL_DIR=/data/onnx_model \
  ./jarvis/reranker/start_reranker.sh
```

### 4. 配置 Jarvis

在 `~/.gemini-jarvis/config.json` 中添加：

```json
"reranker": {
  "enabled": true,
  "baseUrl": "http://localhost:7700",
  "timeoutMs": 15000,
  "maxRetries": 2,
  "candidatePool": 20,
  "memoryRelevanceThreshold": -2
}
```

重启 Jarvis 后生效。日志中出现 `strategy=cross-encoder` 说明精排已启用。

---

## 开机自启（可选）

### macOS — launchd

创建 `~/Library/LaunchAgents/com.jarvis.reranker.plist`（将 `YOUR_USER` 和路径替换为实际值）：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.jarvis.reranker</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/YOUR_USER/onnx_env/bin/python3</string>
    <string>/path/to/jarvis-personal-ai/jarvis/reranker/reranker_service.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>RERANKER_MODEL_DIR</key>
    <string>/Users/YOUR_USER/onnx_model</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/reranker.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/reranker.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.jarvis.reranker.plist
```

### Linux — systemd

创建 `~/.config/systemd/user/jarvis-reranker.service`：

```ini
[Unit]
Description=Jarvis Reranker Service

[Service]
Environment=RERANKER_MODEL_DIR=%h/onnx_model
ExecStart=%h/onnx_env/bin/python3 /path/to/jarvis-personal-ai/jarvis/reranker/reranker_service.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

```bash
systemctl --user enable --now jarvis-reranker
systemctl --user status jarvis-reranker
```

---

## 模型选择

| 模型                                  | 大小   | 中英跨语言 | 推荐场景                                           |
| ------------------------------------- | ------ | ---------- | -------------------------------------------------- |
| `BAAI/bge-reranker-large`             | ~1.3GB | ✅ 优秀    | **推荐**，适合中英混合查询                         |
| `BAAI/bge-reranker-base`              | ~400MB | ✅ 良好    | 内存受限时的替代方案                               |
| `cross-encoder/ms-marco-MiniLM-L6-v2` | ~80MB  | ❌ 仅英文  | 纯英文环境，对 `memoryRelevanceThreshold` 需设为 6 |

切换模型只需重新导出并修改 `RERANKER_MODEL_DIR` 指向新目录。

---

## 故障排查

**服务启动失败**

```bash
cat /tmp/reranker.log
# 常见原因：MODEL_DIR 不存在，或 model.onnx 缺失
```

**所有请求超时**

- 检查 `timeoutMs` 是否够大（bge-large 在 CPU 上首次推理较慢）
- 默认 15000ms，可按需调大

**所有 memories 被过滤（injected=0）**

- 降低 `memoryRelevanceThreshold`（默认 -2，可调至 -5）
- 不同模型的分数范围不同，见[模型选择](#模型选择)
