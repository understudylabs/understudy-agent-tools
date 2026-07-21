# Portable task models

Understudy Desktop can install a task-specific classifier packaged as a directory whose name ends in `.understudy-model`. Open **Trained models** and drag the package onto the window. The app verifies every included file before atomically installing it under `~/.understudy/models/task-models/`.

The package contains the small task-specific parts, not another copy of the base model:

```text
example.understudy-model/
├── manifest.json
├── taxonomy.json
└── model/
    ├── adapter/
    │   ├── adapter_config.json
    │   └── adapters.safetensors
    └── classifier-head.safetensors
```

`manifest.json` uses `understudy.task_model.v1`. It identifies the required MLX-VLM base model, the adapter and classifier head, accepted input columns, the prompt used during training, the taxonomy scorer, and a SHA-256 plus byte count for every member. Paths must be relative and symlinks are rejected.

## Test a model

1. Download the base model named by the bundle in Models.
2. Open **Trained models** and drag in the `.understudy-model` package.
3. Choose the installed package, enter an example, and run it locally.
4. For repeatable scoring, import a CSV or JSONL eval. Each row needs an input and expected answer; the expected answer may be either the detailed taxonomy label id or its exact label text.

The runner loads the local base, applies the adapter and classifier head, returns the top choices, and stores each right or wrong answer in the normal evaluation results. Model packages are data artifacts; they do not carry executable Python or shell code.
