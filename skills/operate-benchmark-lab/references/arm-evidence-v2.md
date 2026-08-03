# Arm evidence v2

Before provider work or spend, emit `understudy.arm_evidence.v2` using `assertArmEntryEvidence`. Bind source, verifier calibration, immutable train/dev/holdout split hashes, and explicit pre-spend authorization by refs and SHA-256 hashes. Holdout evidence is refusal metadata for no-hash, wrong-hash, and exact-hash requests; it must state `opened: false`. The gate never opens or reads holdout data. Records are strict, hash/reference-only, and must contain no prompts, traces, secrets, credentials, tokens, or weights.
