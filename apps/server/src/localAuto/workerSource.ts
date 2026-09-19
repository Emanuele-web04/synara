// Kept as a source string so the Python worker ships inside the bundled CLI.
// Model input is constructed in input.ts; never apply a chat template here.
export const LOCAL_AUTO_WORKER = String.raw`
import json
import math
import os
import shutil
import sys
from pathlib import Path

MODEL = "ProCreations/auto-0.4b-2"
REVISION = "5937dd0162a9dd564a07c812b65012681daae3fd"
FLASH = "kernels-community/flash-attn2@81fb77c12b2ad5d69380669b46739d5868614502"


def emit(value):
    print(json.dumps(value, allow_nan=False), flush=True)


def main():
    import torch
    from transformers import AutoModelForSequenceClassification, AutoTokenizer
    from huggingface_hub import snapshot_download

    root = Path(sys.argv[1]).resolve()
    os.chdir(root)
    installing = "--install" in sys.argv
    model_dir = root / "model"
    if installing:
        snapshot_download(MODEL, revision=REVISION, local_dir=str(model_dir),
                          allow_patterns=["config.json", "model.safetensors", "tokenizer.json", "tokenizer_config.json"])
    tokenizer = AutoTokenizer.from_pretrained(model_dir, local_files_only=True, trust_remote_code=False)
    torch.set_num_threads(max(1, min(8, os.cpu_count() or 1)))
    devices = []
    if torch.cuda.is_available():
        devices.append("cuda")
    if torch.backends.mps.is_available():
        devices.append("mps")
    devices.append("cpu")
    model = None
    for device in devices:
        # Use the model card's BF16 FlashAttention path where supported. SDPA
        # avoids CUDA-only dependencies on MPS/CPU; cap its quadratic masks.
        attention_options = ["sdpa"]
        if device == "cuda" and torch.cuda.is_bf16_supported():
            attention_options.insert(0, FLASH)
        for attention in attention_options:
            try:
                if attention == FLASH:
                    # Hub's offline snapshot check rejects a cache containing only
                    # one build variant. Materialize the pinned variant once and
                    # use kernels' local loader (also avoids Windows drive colons).
                    repo, revision = FLASH.split("@")
                    if installing:
                        from kernels import install_kernel
                        variant = install_kernel(repo, revision=revision, validate_dependencies=True)
                        shutil.copytree(variant, root / "flash" / "build" / variant.name, dirs_exist_ok=True)
                    if not (root / "flash" / "build").is_dir():
                        raise RuntimeError("FlashAttention is not installed")
                    os.environ["LOCAL_KERNELS"] = repo + "=flash"
                dtype = torch.bfloat16 if device == "cuda" and torch.cuda.is_bf16_supported() else torch.float32
                candidate = AutoModelForSequenceClassification.from_pretrained(
                    model_dir, local_files_only=True, trust_remote_code=False,
                    dtype=dtype, attn_implementation=attention,
                ).to(device).eval()
                if candidate.config.id2label != {0: "approve", 1: "deny"}:
                    raise RuntimeError("Unexpected classifier labels")
                with torch.inference_mode():
                    probe = tokenizer("### PROPOSED TOOL CALL\ntool: Bash\nargs: pwd\n\n### USER REQUEST\nShow the current directory.\n\n### AGENT HISTORY\n(no prior actions)", return_tensors="pt").to(device)
                    logits = candidate(**probe).logits
                    if logits.shape != (1, 2) or not torch.isfinite(logits).all():
                        raise RuntimeError("Classifier self-test returned invalid logits")
                model = candidate
                break
            except Exception as error:
                print(f"{device} initialization failed: {type(error).__name__}: {error}", file=sys.stderr, flush=True)
                candidate = None
                if device == "cuda":
                    torch.cuda.empty_cache()
        if model is not None:
            break
    if model is None:
        raise RuntimeError("Could not load the classifier on this device")
    max_tokens = 65536 if attention == FLASH else 4096
    device_label = torch.cuda.get_device_name(0) if device == "cuda" else ("Apple Silicon · Metal" if device == "mps" else "CPU")
    emit({"device": device_label, "maxTokens": max_tokens})
    if installing:
        return
    for line in sys.stdin:
        try:
            text = json.loads(line)["text"]
            inputs = tokenizer(text, return_tensors="pt", truncation=False)
            token_count = inputs["input_ids"].shape[1]
            if token_count > max_tokens:
                emit({"decision": "ask", "reason": "Context exceeds the device's token limit", "tokens": token_count})
                continue
            with torch.inference_mode():
                logits = model(**inputs.to(device)).logits.float()
                if logits.shape != (1, 2) or not torch.isfinite(logits).all():
                    raise RuntimeError("Invalid logits")
                p_deny = logits.softmax(-1)[0, 1].item()
            if not math.isfinite(p_deny):
                raise RuntimeError("Invalid probability")
            emit({"decision": "deny" if p_deny >= 0.5 else "approve", "pDeny": p_deny, "tokens": token_count})
        except Exception as error:
            # Never echo private tool inputs into diagnostics.
            emit({"decision": "ask", "reason": f"Classifier unavailable ({type(error).__name__})"})


if __name__ == "__main__":
    main()
`;
