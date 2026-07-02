//! GEPA run artifact loading for the Optimization pane.
//!
//! Parses the JSON produced by the `gepa` Python package's
//! `GEPAResult.to_dict()` (validation schema v2, with tolerance for the
//! legacy v0/v1 list-based shape) and normalizes it into a view the
//! frontend can render directly: candidate lineage (tree), per-candidate
//! validation scores, discovery budget, and the Pareto-front/dominator
//! roles that GEPA's own visualization uses.
//!
//! This is a file-based viewer: it never runs GEPA. `gepa_state.bin` is a
//! Python pickle and is deliberately not supported — runs are loaded from
//! the JSON result artifact.

use serde::Serialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

/// Highest `validation_schema_version` this viewer understands
/// (mirrors `GEPAResult._VALIDATION_SCHEMA_VERSION` in gepa 0.1.x).
const MAX_SCHEMA_VERSION: u64 = 2;

/// The demo artifact bundled so the pane always renders. Synthetic
/// retail-exchange workload; validated to round-trip through the real
/// `gepa` package's `GEPAResult.from_dict`.
const DEMO_RUN_JSON: &str = include_str!("../knowledge/gepa_demo_run.json");
pub const DEMO_SOURCE: &str = "demo";

#[derive(Serialize, Clone, Debug)]
pub struct GepaCandidateView {
    pub idx: usize,
    /// Component name → component text (usually the evolved prompt(s)).
    pub components: BTreeMap<String, String>,
    /// Parent candidate indices (empty for the seed; two for a merge).
    pub parents: Vec<usize>,
    /// Aggregate validation score.
    pub val_score: Option<f64>,
    /// Total metric calls consumed when this candidate was discovered.
    pub discovery_evals: Option<u64>,
    /// Per-instance scores aligned with `GepaRunView::val_ids` (None where
    /// the run recorded no score for that instance).
    pub subscores: Vec<Option<f64>>,
    /// Validation instance ids where this candidate is on the per-instance
    /// Pareto front (ties included, as GEPA records them).
    pub front_instance_ids: Vec<String>,
    /// True when the candidate survives GEPA's dominator reduction — the
    /// minimal set that still covers every per-instance front.
    pub is_dominator: bool,
    pub is_best: bool,
    /// Depth in the lineage tree (seed = 0; merge = 1 + deepest parent).
    pub generation: usize,
}

#[derive(Serialize, Clone, Debug)]
pub struct GepaRunView {
    /// Where the run came from: `"demo"` or the loaded file path.
    pub source: String,
    pub schema_version: u64,
    pub best_idx: usize,
    /// Ordered validation instance ids (subscore columns align with this).
    pub val_ids: Vec<String>,
    pub candidates: Vec<GepaCandidateView>,
    /// Dominator candidate indices (GEPA's `find_dominator_programs`).
    pub dominators: Vec<usize>,
    pub total_metric_calls: Option<u64>,
    pub num_full_val_evals: Option<u64>,
    pub seed: Option<i64>,
    pub run_dir: Option<String>,
    pub is_demo: bool,
}

/// Load the bundled demo run. Infallible in practice (the artifact is
/// compiled in and covered by tests) but surfaces a parse error honestly.
#[tauri::command]
pub fn gepa_demo_run() -> Result<GepaRunView, String> {
    parse_run(DEMO_RUN_JSON, DEMO_SOURCE, true)
}

/// Load a GEPA run artifact from disk. Accepts a `GEPAResult.to_dict()`
/// JSON file, or a run directory containing `gepa-result.json` /
/// `gepa_result.json`.
#[tauri::command]
pub fn gepa_load_run(path: String) -> Result<GepaRunView, String> {
    let requested = Path::new(&path);
    let file = if requested.is_dir() {
        ["gepa-result.json", "gepa_result.json"]
            .iter()
            .map(|name| requested.join(name))
            .find(|p| p.is_file())
            .ok_or_else(|| {
                format!(
                    "{path} is a directory without a gepa-result.json. Export one with \
                     `json.dump(result.to_dict(), f)` in Python — gepa_state.bin is a \
                     pickle and cannot be read here."
                )
            })?
    } else {
        requested.to_path_buf()
    };
    let raw = std::fs::read_to_string(&file)
        .map_err(|e| format!("could not read {}: {e}", file.display()))?;
    parse_run(&raw, &file.display().to_string(), false)
}

pub fn parse_run(raw: &str, source: &str, is_demo: bool) -> Result<GepaRunView, String> {
    let root: Value =
        serde_json::from_str(raw).map_err(|e| format!("not valid JSON: {e}"))?;
    let obj = root
        .as_object()
        .ok_or("expected a JSON object (GEPAResult.to_dict())")?;

    let schema_version = match obj.get("validation_schema_version") {
        None | Some(Value::Null) => 0,
        Some(v) => v
            .as_u64()
            .ok_or("validation_schema_version must be a non-negative integer")?,
    };
    if schema_version > MAX_SCHEMA_VERSION {
        return Err(format!(
            "unsupported GEPAResult validation schema version {schema_version}; \
             max supported is {MAX_SCHEMA_VERSION}"
        ));
    }

    let components = parse_candidates(obj.get("candidates"))?;
    let n = components.len();
    if n == 0 {
        return Err("run has no candidates".into());
    }

    let parents = parse_parents(obj.get("parents"), n)?;
    let val_scores = parse_scores(obj.get("val_aggregate_scores"), n)?;
    let (val_ids, subscores) = parse_subscores(obj.get("val_subscores"), n, schema_version)?;
    let fronts = parse_fronts(
        obj.get("per_val_instance_best_candidates"),
        n,
        schema_version,
        &val_ids,
    )?;
    let discovery = parse_discovery(obj.get("discovery_eval_counts"), n)?;

    // Merge front-map val ids into the subscore-derived ordering so every
    // instance appears even if one side is missing it.
    let mut all_val_ids: Vec<String> = val_ids.clone();
    for id in fronts.keys() {
        if !all_val_ids.iter().any(|v| v == id) {
            all_val_ids.push(id.clone());
        }
    }

    let best_idx = best_index(&val_scores)?;
    let generations = compute_generations(&parents);
    let dominators = find_dominators(&fronts, &val_scores);
    let dominator_set: BTreeSet<usize> = dominators.iter().copied().collect();

    let candidates = (0..n)
        .map(|idx| {
            let front_instance_ids: Vec<String> = all_val_ids
                .iter()
                .filter(|id| fronts.get(*id).is_some_and(|f| f.contains(&idx)))
                .cloned()
                .collect();
            GepaCandidateView {
                idx,
                components: components[idx].clone(),
                parents: parents[idx].clone(),
                val_score: val_scores[idx],
                discovery_evals: discovery[idx],
                subscores: all_val_ids
                    .iter()
                    .map(|id| subscores[idx].get(id).copied())
                    .collect(),
                front_instance_ids,
                is_dominator: dominator_set.contains(&idx),
                is_best: idx == best_idx,
                generation: generations[idx],
            }
        })
        .collect();

    Ok(GepaRunView {
        source: source.to_string(),
        schema_version,
        best_idx,
        val_ids: all_val_ids,
        candidates,
        dominators,
        total_metric_calls: obj.get("total_metric_calls").and_then(Value::as_u64),
        num_full_val_evals: obj.get("num_full_val_evals").and_then(Value::as_u64),
        seed: obj.get("seed").and_then(Value::as_i64),
        run_dir: obj
            .get("run_dir")
            .and_then(Value::as_str)
            .map(str::to_string),
        is_demo,
    })
}

fn parse_candidates(v: Option<&Value>) -> Result<Vec<BTreeMap<String, String>>, String> {
    let arr = v
        .and_then(Value::as_array)
        .ok_or("candidates must be an array of component maps")?;
    arr.iter()
        .enumerate()
        .map(|(i, cand)| {
            let map = cand
                .as_object()
                .ok_or(format!("candidates[{i}] must be an object"))?;
            map.iter()
                .map(|(k, val)| match val {
                    Value::String(s) => Ok((k.clone(), s.clone())),
                    other => Err(format!(
                        "candidates[{i}].{k} must be a string, got {other}"
                    )),
                })
                .collect()
        })
        .collect()
}

fn parse_parents(v: Option<&Value>, n: usize) -> Result<Vec<Vec<usize>>, String> {
    let arr = v
        .and_then(Value::as_array)
        .ok_or("parents must be an array of parent-index lists")?;
    if arr.len() != n {
        return Err(format!(
            "parents has {} entries but there are {n} candidates",
            arr.len()
        ));
    }
    arr.iter()
        .enumerate()
        .map(|(child, row)| {
            let row = row
                .as_array()
                .ok_or(format!("parents[{child}] must be a list"))?;
            let mut out = Vec::new();
            for p in row {
                match p {
                    Value::Null => {}
                    Value::Number(num) => {
                        let idx = num
                            .as_u64()
                            .ok_or(format!("parents[{child}] contains a non-index {num}"))?
                            as usize;
                        // GEPA discovers children after parents; enforcing
                        // parent < child keeps the lineage a DAG we can walk.
                        if idx >= child {
                            return Err(format!(
                                "parents[{child}] references candidate {idx}, which is not \
                                 an earlier candidate — lineage must be topological"
                            ));
                        }
                        out.push(idx);
                    }
                    other => {
                        return Err(format!("parents[{child}] contains {other}, expected an index or null"))
                    }
                }
            }
            Ok(out)
        })
        .collect()
}

fn parse_scores(v: Option<&Value>, n: usize) -> Result<Vec<Option<f64>>, String> {
    let arr = v
        .and_then(Value::as_array)
        .ok_or("val_aggregate_scores must be an array of numbers")?;
    if arr.len() != n {
        return Err(format!(
            "val_aggregate_scores has {} entries but there are {n} candidates",
            arr.len()
        ));
    }
    arr.iter()
        .enumerate()
        .map(|(i, s)| match s {
            Value::Null => Ok(None),
            Value::Number(num) => Ok(num.as_f64()),
            other => Err(format!("val_aggregate_scores[{i}] is {other}, expected a number")),
        })
        .collect()
}

/// Returns the ordered val ids plus, per candidate, a map val id → score.
#[allow(clippy::type_complexity)]
fn parse_subscores(
    v: Option<&Value>,
    n: usize,
    schema_version: u64,
) -> Result<(Vec<String>, Vec<BTreeMap<String, f64>>), String> {
    let arr = match v {
        None | Some(Value::Null) => return Ok((Vec::new(), vec![BTreeMap::new(); n])),
        Some(v) => v.as_array().ok_or("val_subscores must be an array")?,
    };
    if arr.len() != n {
        return Err(format!(
            "val_subscores has {} entries but there are {n} candidates",
            arr.len()
        ));
    }
    let mut ordered_ids: Vec<String> = Vec::new();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut per_candidate = Vec::with_capacity(n);
    for (i, row) in arr.iter().enumerate() {
        let mut map = BTreeMap::new();
        let entries: Vec<(String, &Value)> = if schema_version >= 2 {
            row.as_object()
                .ok_or(format!("val_subscores[{i}] must be an object (schema v2)"))?
                .iter()
                .map(|(k, val)| (k.clone(), val))
                .collect()
        } else {
            // Legacy v0/v1: a plain list, positional instance ids.
            row.as_array()
                .ok_or(format!("val_subscores[{i}] must be a list (legacy schema)"))?
                .iter()
                .enumerate()
                .map(|(j, val)| (j.to_string(), val))
                .collect()
        };
        for (id, val) in entries {
            let score = match val {
                Value::Null => continue,
                Value::Number(num) => num
                    .as_f64()
                    .ok_or(format!("val_subscores[{i}][{id}] is not a finite number"))?,
                other => {
                    return Err(format!(
                        "val_subscores[{i}][{id}] is {other}, expected a number"
                    ))
                }
            };
            if seen.insert(id.clone()) {
                ordered_ids.push(id.clone());
            }
            map.insert(id, score);
        }
        per_candidate.push(map);
    }
    Ok((ordered_ids, per_candidate))
}

/// Per-instance Pareto fronts: val id → set of candidate indices.
fn parse_fronts(
    v: Option<&Value>,
    n: usize,
    schema_version: u64,
    _val_ids: &[String],
) -> Result<BTreeMap<String, BTreeSet<usize>>, String> {
    let mut out = BTreeMap::new();
    let entries: Vec<(String, &Value)> = match v {
        None | Some(Value::Null) => return Ok(out),
        Some(v) if schema_version >= 2 => v
            .as_object()
            .ok_or("per_val_instance_best_candidates must be an object (schema v2)")?
            .iter()
            .map(|(k, val)| (k.clone(), val))
            .collect(),
        Some(v) => v
            .as_array()
            .ok_or("per_val_instance_best_candidates must be a list (legacy schema)")?
            .iter()
            .enumerate()
            .map(|(j, val)| (j.to_string(), val))
            .collect(),
    };
    for (id, front) in entries {
        let front = front
            .as_array()
            .ok_or(format!("per_val_instance_best_candidates[{id}] must be a list"))?;
        let mut set = BTreeSet::new();
        for member in front {
            let idx = member
                .as_u64()
                .ok_or(format!(
                    "per_val_instance_best_candidates[{id}] contains {member}, expected a candidate index"
                ))? as usize;
            if idx >= n {
                return Err(format!(
                    "per_val_instance_best_candidates[{id}] references candidate {idx}, \
                     but there are only {n} candidates"
                ));
            }
            set.insert(idx);
        }
        out.insert(id, set);
    }
    Ok(out)
}

fn parse_discovery(v: Option<&Value>, n: usize) -> Result<Vec<Option<u64>>, String> {
    let arr = match v {
        None | Some(Value::Null) => return Ok(vec![None; n]),
        Some(v) => v
            .as_array()
            .ok_or("discovery_eval_counts must be an array")?,
    };
    if arr.len() != n {
        return Err(format!(
            "discovery_eval_counts has {} entries but there are {n} candidates",
            arr.len()
        ));
    }
    Ok(arr.iter().map(Value::as_u64).collect())
}

fn best_index(scores: &[Option<f64>]) -> Result<usize, String> {
    scores
        .iter()
        .enumerate()
        .filter_map(|(i, s)| s.map(|s| (i, s)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .map(|(i, _)| i)
        .ok_or_else(|| "run has no scored candidates".into())
}

/// Seed = generation 0; every child sits one level below its deepest parent.
/// Safe because `parse_parents` enforces parent < child.
fn compute_generations(parents: &[Vec<usize>]) -> Vec<usize> {
    let mut gen = vec![0usize; parents.len()];
    for (child, pars) in parents.iter().enumerate() {
        gen[child] = pars.iter().map(|&p| gen[p] + 1).max().unwrap_or(0);
    }
    gen
}

/// Port of gepa's `find_dominator_programs` / `remove_dominated_programs`:
/// greedily discard (lowest aggregate score first) any candidate whose every
/// per-instance front is still covered by the remaining candidates. What
/// survives is the minimal set that "illuminates" the whole valset.
fn find_dominators(
    fronts: &BTreeMap<String, BTreeSet<usize>>,
    scores: &[Option<f64>],
) -> Vec<usize> {
    let mut programs: Vec<usize> = fronts
        .values()
        .flat_map(|f| f.iter().copied())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    programs.sort_by(|&a, &b| {
        let sa = scores.get(a).copied().flatten().unwrap_or(f64::NEG_INFINITY);
        let sb = scores.get(b).copied().flatten().unwrap_or(f64::NEG_INFINITY);
        sa.total_cmp(&sb).then(a.cmp(&b))
    });

    let mut dominated: BTreeSet<usize> = BTreeSet::new();
    loop {
        let mut removed = false;
        for &y in &programs {
            if dominated.contains(&y) {
                continue;
            }
            let is_dominated = fronts
                .values()
                .filter(|front| front.contains(&y))
                .all(|front| {
                    front
                        .iter()
                        .any(|&other| other != y && !dominated.contains(&other))
                });
            if is_dominated {
                dominated.insert(y);
                removed = true;
                break;
            }
        }
        if !removed {
            break;
        }
    }
    programs.retain(|p| !dominated.contains(p));
    programs.sort_unstable();
    programs
}

#[cfg(test)]
mod tests {
    use super::*;

    fn demo() -> GepaRunView {
        parse_run(DEMO_RUN_JSON, DEMO_SOURCE, true).expect("demo artifact parses")
    }

    #[test]
    fn demo_artifact_parses_and_normalizes() {
        let run = demo();
        assert_eq!(run.candidates.len(), 10);
        assert_eq!(run.val_ids.len(), 8);
        assert_eq!(run.best_idx, 8);
        assert!(run.is_demo);
        assert_eq!(run.schema_version, 2);
        assert_eq!(run.total_metric_calls, Some(180));

        // Matches gepa's find_dominator_programs on the same data
        // (verified against the real package during development).
        assert_eq!(run.dominators, vec![6, 8]);

        let seed = &run.candidates[0];
        assert!(seed.parents.is_empty());
        assert_eq!(seed.generation, 0);
        assert!(seed.components.contains_key("system_prompt"));

        // Candidate 7 is the merge: two parents, one generation below the deepest.
        let merge = &run.candidates[7];
        assert_eq!(merge.parents, vec![5, 4]);
        assert_eq!(merge.generation, 4);

        let best = &run.candidates[8];
        assert!(best.is_best && best.is_dominator);
        assert_eq!(best.subscores.len(), run.val_ids.len());
        assert!(best.val_score.is_some_and(|s| (s - 0.875).abs() < 1e-9));

        // Candidate 6 leads exchange-057 alone — the illumination story.
        let specialist = &run.candidates[6];
        assert!(specialist.is_dominator && !specialist.is_best);
        assert!(specialist
            .front_instance_ids
            .iter()
            .any(|id| id == "exchange-057"));
    }

    #[test]
    fn rejects_malformed_json() {
        let err = parse_run("{not json", "test", false).unwrap_err();
        assert!(err.contains("not valid JSON"), "{err}");
        let err = parse_run("[1,2,3]", "test", false).unwrap_err();
        assert!(err.contains("expected a JSON object"), "{err}");
    }

    #[test]
    fn rejects_future_schema_version() {
        let raw = r#"{"validation_schema_version": 3, "candidates": []}"#;
        let err = parse_run(raw, "test", false).unwrap_err();
        assert!(err.contains("unsupported"), "{err}");
    }

    #[test]
    fn rejects_mismatched_lengths() {
        let raw = r#"{
            "validation_schema_version": 2,
            "candidates": [{"p": "a"}, {"p": "b"}],
            "parents": [[null]],
            "val_aggregate_scores": [0.5, 0.6],
            "val_subscores": [{}, {}],
            "per_val_instance_best_candidates": {}
        }"#;
        let err = parse_run(raw, "test", false).unwrap_err();
        assert!(err.contains("parents has 1 entries"), "{err}");
    }

    #[test]
    fn rejects_non_topological_lineage() {
        let raw = r#"{
            "validation_schema_version": 2,
            "candidates": [{"p": "a"}, {"p": "b"}],
            "parents": [[1], [null]],
            "val_aggregate_scores": [0.5, 0.6],
            "val_subscores": [{}, {}],
            "per_val_instance_best_candidates": {}
        }"#;
        let err = parse_run(raw, "test", false).unwrap_err();
        assert!(err.contains("topological"), "{err}");
    }

    #[test]
    fn rejects_front_index_out_of_range() {
        let raw = r#"{
            "validation_schema_version": 2,
            "candidates": [{"p": "a"}],
            "parents": [[null]],
            "val_aggregate_scores": [0.5],
            "val_subscores": [{"v0": 0.5}],
            "per_val_instance_best_candidates": {"v0": [4]}
        }"#;
        let err = parse_run(raw, "test", false).unwrap_err();
        assert!(err.contains("only 1 candidates"), "{err}");
    }

    #[test]
    fn rejects_non_string_component() {
        let raw = r#"{
            "validation_schema_version": 2,
            "candidates": [{"p": 42}],
            "parents": [[null]],
            "val_aggregate_scores": [0.5],
            "val_subscores": [{}],
            "per_val_instance_best_candidates": {}
        }"#;
        let err = parse_run(raw, "test", false).unwrap_err();
        assert!(err.contains("must be a string"), "{err}");
    }

    #[test]
    fn parses_legacy_v0_lists() {
        // Pre-v2 shape: subscores are positional lists and the front map is
        // a list of per-instance lists.
        let raw = r#"{
            "candidates": [{"p": "seed"}, {"p": "child"}],
            "parents": [[null], [0]],
            "val_aggregate_scores": [0.25, 0.75],
            "val_subscores": [[0.0, 0.5], [0.5, 1.0]],
            "per_val_instance_best_candidates": [[1], [1]],
            "discovery_eval_counts": [2, 6]
        }"#;
        let run = parse_run(raw, "test", false).expect("legacy artifact parses");
        assert_eq!(run.schema_version, 0);
        assert_eq!(run.best_idx, 1);
        assert_eq!(run.val_ids, vec!["0".to_string(), "1".to_string()]);
        assert_eq!(run.dominators, vec![1]);
        assert_eq!(run.candidates[1].generation, 1);
        assert_eq!(run.candidates[1].discovery_evals, Some(6));
    }

    #[test]
    fn missing_optional_fields_are_tolerated() {
        let raw = r#"{
            "validation_schema_version": 2,
            "candidates": [{"p": "seed"}],
            "parents": [[null]],
            "val_aggregate_scores": [0.5]
        }"#;
        let run = parse_run(raw, "test", false).expect("minimal artifact parses");
        assert_eq!(run.best_idx, 0);
        assert!(run.val_ids.is_empty());
        assert!(run.dominators.is_empty());
        assert_eq!(run.candidates[0].discovery_evals, None);
    }

    #[test]
    fn no_scored_candidates_is_an_error() {
        let raw = r#"{
            "validation_schema_version": 2,
            "candidates": [{"p": "seed"}],
            "parents": [[null]],
            "val_aggregate_scores": [null]
        }"#;
        let err = parse_run(raw, "test", false).unwrap_err();
        assert!(err.contains("no scored candidates"), "{err}");
    }

    #[test]
    fn load_run_rejects_missing_and_dir_without_artifact() {
        let err = gepa_load_run("/nonexistent/gepa.json".into()).unwrap_err();
        assert!(err.contains("could not read"), "{err}");

        let dir = std::env::temp_dir().join("gepa-viz-test-empty-dir");
        std::fs::create_dir_all(&dir).unwrap();
        let err = gepa_load_run(dir.display().to_string()).unwrap_err();
        assert!(err.contains("gepa-result.json"), "{err}");
    }
}
