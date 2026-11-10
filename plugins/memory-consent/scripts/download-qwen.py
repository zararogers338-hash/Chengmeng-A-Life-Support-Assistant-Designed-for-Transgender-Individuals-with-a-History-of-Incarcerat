"""Explicit setup only. Downloads a pinned, public model; never reads user data."""
import argparse
import json
import hashlib
import urllib.request
import os
from pathlib import Path

MODEL = "Qwen/Qwen3-Embedding-0.6B"
REVISION = "97b0c614be4d77ee51c0cef4e5f07c00f9eb65b3"
WEIGHTS_SHA256 = "0437e45c94563b09e13cb7a64478fc406947a93cb34a7e05870fc8dcd48e23fd"

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--destination", required=True)
    parser.add_argument("--source", choices=["huggingface", "modelscope"], default="huggingface")
    parser.add_argument("--direct", action="store_true")
    args = parser.parse_args()
    destination = Path(args.destination).resolve()
    destination.mkdir(parents=True, exist_ok=True)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if args.direct else urllib.request.build_opener()
    files = {}
    if args.source == 'huggingface':
        with opener.open(f"https://huggingface.co/api/models/{MODEL}/revision/{REVISION}?blobs=true", timeout=60) as response:
            metadata = json.load(response)
        files = {item['rfilename']: item for item in metadata['siblings']}
    for name in ["config.json", "tokenizer.json", "tokenizer_config.json", "merges.txt", "vocab.json", "README.md", "model.safetensors"]:
        target = destination / name
        expected = WEIGHTS_SHA256 if name == 'model.safetensors' else files.get(name, {}).get('lfs', {}).get('sha256')
        def valid():
            if not target.exists() or target.stat().st_size == 0 or (files.get(name, {}).get('size') is not None and target.stat().st_size != files[name]['size']):
                return False
            if expected:
                with target.open('rb') as source:
                    return hashlib.file_digest(source, 'sha256').hexdigest() == expected
            return True
        if valid():
            print(f"Verified {name}", flush=True)
            continue
        print(f"Downloading {name}", flush=True)
        url = f"https://huggingface.co/{MODEL}/resolve/{REVISION}/{name}?download=true" if args.source == 'huggingface' else f"https://modelscope.cn/models/{MODEL}/resolve/master/{name}"
        request = urllib.request.Request(url, headers={'User-Agent': 'ChengmengModelSetup/0.1'})
        partial = target.with_suffix(target.suffix + '.part')
        with opener.open(request, timeout=180) as response, partial.open('wb') as out:
            while chunk := response.read(4 * 1024 * 1024):
                out.write(chunk)
        os.replace(partial, target)
        if not valid():
            raise RuntimeError(f"Model checksum/size mismatch: {name}")
    (destination / "chengmeng-model.json").write_text(json.dumps({
        "model": MODEL, "revision": REVISION, "license": "Apache-2.0",
        "weights_sha256": WEIGHTS_SHA256, "download_source": args.source,
    }, indent=2), encoding="utf-8")
    print("Pinned Qwen embedding model downloaded.")
