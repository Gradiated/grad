# grad-trainer

Python training runtime, 6 v0 recipes (`sft`, `dpo`, `router`, `decision`, `cartridge`, `embedding`), `gradiated.cartridge/1` safetensors exporter, Tier-1 trace connectors, and HTTP worker daemon for `grad-server`.

- Zero heavy required dependencies in CPU/dev mode (stdlib only).
- Optional GPU extras: `pip install -e ".[gpu]"` for PyTorch + PEFT + Transformers.
- Run tests: `python3 -m unittest discover -s tests -v`.
