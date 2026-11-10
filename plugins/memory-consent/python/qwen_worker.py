"""CPU-only, offline embedding worker. JSON lines over stdin/stdout, no ports."""
import os
os.environ.update(HF_HUB_OFFLINE="1", TRANSFORMERS_OFFLINE="1", HF_HUB_DISABLE_TELEMETRY="1",
                  TOKENIZERS_PARALLELISM="false", CUDA_VISIBLE_DEVICES="", DO_NOT_TRACK="1")
import argparse
import contextlib
import json
import sys

QUERY_INSTRUCTION = "Given a user's question, retrieve relevant user-confirmed personal memories."


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--dimensions", type=int, default=1024)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--max-tokens", type=int, default=2048)
    args = parser.parse_args()
    model = tokenizer = torch = None
    for line in sys.stdin.buffer:
        request = {}
        try:
            if len(line) > 1024 * 1024:
                raise ValueError("REQUEST_TOO_LARGE")
            request = json.loads(line)
            texts = request.get("texts")
            kind = request.get("kind")
            if kind not in ("query", "document") or not isinstance(texts, list) or not 1 <= len(texts) <= 8:
                raise ValueError("INVALID_REQUEST")
            if any(not isinstance(t, str) or not t.strip() or len(t) > 16000 for t in texts):
                raise ValueError("INVALID_TEXT")
            if model is None:
                with contextlib.redirect_stdout(sys.stderr):
                    import torch
                    from transformers import AutoModel, AutoTokenizer
                    torch.set_num_threads(max(1, min(16, args.threads)))
                    tokenizer = AutoTokenizer.from_pretrained(args.model_dir, local_files_only=True,
                                                              trust_remote_code=False, padding_side="left")
                    model = AutoModel.from_pretrained(args.model_dir, local_files_only=True,
                                                     trust_remote_code=False, use_safetensors=True,
                                                     torch_dtype=torch.float32, attn_implementation="sdpa")
                    model.eval()
            inputs = [f"Instruct: {QUERY_INSTRUCTION}\nQuery:{t}" for t in texts] if kind == "query" else texts
            batch = tokenizer(inputs, padding=True, truncation=False, return_tensors="pt")
            if batch["input_ids"].shape[1] > args.max_tokens:
                raise ValueError("EMBEDDING_TEXT_TOO_LONG")
            with torch.inference_mode():
                hidden = model(**batch).last_hidden_state
                # Left-padding: the final token is the final non-padding token.
                vectors = torch.nn.functional.normalize(hidden[:, -1, :args.dimensions].float(), p=2, dim=1)
            response = {"id": request.get("id"), "ok": True, "device": "cpu", "vectors": vectors.tolist()}
            del hidden, vectors, batch, inputs
        except Exception as exc:
            # Never put model input, local paths or library tracebacks on the wire.
            code = str(exc) if isinstance(exc, ValueError) and str(exc) in {
                "REQUEST_TOO_LARGE", "INVALID_REQUEST", "INVALID_TEXT", "EMBEDDING_TEXT_TOO_LONG"
            } else "QWEN_WORKER_FAILED"
            response = {"id": request.get("id"), "ok": False, "error": code}
        sys.stdout.write(json.dumps(response, ensure_ascii=True, separators=(",", ":")) + "\n")
        sys.stdout.flush()
        del request, response


if __name__ == "__main__":
    main()
