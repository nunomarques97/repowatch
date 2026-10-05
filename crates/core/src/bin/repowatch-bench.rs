//! Measures a dashboard scan: discovery plus one summary per repository,
//! read as the app reads them (up to 8 repositories at the same time).
//!
//! Only the core read path is used ([`repowatch_core::discover`] and
//! [`repowatch_core::summarize`]): no fetch, no optional locks, no writes,
//! no lost-commit search. It is safe on real repositories.
//!
//! Usage: repowatch-bench [--runs <n>] [--threads <n>] [--exclude <path>]...
//!                        [--slowest <n>] <root>...
//!
//! Prints one JSON object on stdout: the repository count, every run's
//! discovery, summary and total times in milliseconds, and the slowest
//! repositories of the last run.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use repowatch_core::{DiscoveredRepo, DiscoveryOptions, Git, RepoSummary, discover, summarize};

/// Most repositories summarized at the same time, as in the app's scanner.
const MAX_SCAN_THREADS: usize = 8;
const MAX_RUNS: usize = 100;

const USAGE: &str = "usage: repowatch-bench [--runs <n>] [--threads <n>] [--exclude <path>]... \
                     [--slowest <n>] <root>...";

struct Options {
    roots: Vec<PathBuf>,
    excluded: Vec<PathBuf>,
    runs: usize,
    threads: usize,
    slowest: usize,
}

struct Run {
    discovery: Duration,
    summaries: Duration,
    total: Duration,
    repos: usize,
    errors: usize,
    attention: usize,
    issues: usize,
    timings: Vec<(Duration, String)>,
}

fn main() -> ExitCode {
    let options = match parse_args(std::env::args().skip(1)) {
        Ok(options) => options,
        Err(message) => {
            eprintln!("repowatch-bench: {message}\n{USAGE}");
            return ExitCode::from(2);
        }
    };
    let git = Git::new();
    let runs: Vec<Run> = (0..options.runs).map(|_| scan(&git, &options)).collect();
    println!("{}", report(&options, &runs));
    ExitCode::SUCCESS
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<Options, String> {
    let default_threads = thread::available_parallelism()
        .map_or(4, |count| count.get())
        .clamp(1, MAX_SCAN_THREADS);
    let mut options = Options {
        roots: Vec::new(),
        excluded: Vec::new(),
        runs: 1,
        threads: default_threads,
        slowest: 5,
    };
    let mut args = args.peekable();
    while let Some(arg) = args.next() {
        let mut value = |name: &str| args.next().ok_or_else(|| format!("{name} needs a value"));
        match arg.as_str() {
            "--runs" => options.runs = count(&value("--runs")?, "--runs", MAX_RUNS)?,
            "--threads" => {
                options.threads = count(&value("--threads")?, "--threads", MAX_SCAN_THREADS)?;
            }
            "--slowest" => options.slowest = count(&value("--slowest")?, "--slowest", 1000)?,
            "--exclude" => options.excluded.push(absolute(&value("--exclude")?)?),
            other if other.starts_with('-') => return Err(format!("unknown option {other}")),
            root => options.roots.push(absolute(root)?),
        }
    }
    if options.roots.is_empty() {
        return Err("no root folder given".into());
    }
    Ok(options)
}

fn count(text: &str, name: &str, max: usize) -> Result<usize, String> {
    match text.parse::<usize>() {
        Ok(value) if (1..=max).contains(&value) => Ok(value),
        _ => Err(format!("{name} must be a number from 1 to {max}")),
    }
}

fn absolute(text: &str) -> Result<PathBuf, String> {
    std::path::absolute(text).map_err(|error| format!("bad path {text}: {error}"))
}

fn scan(git: &Git, options: &Options) -> Run {
    let discovery_options = DiscoveryOptions {
        excluded: options.excluded.clone(),
        ..DiscoveryOptions::default()
    };
    let start = Instant::now();
    let discovery = discover(&options.roots, &discovery_options);
    let discovered = start.elapsed();
    let results = summarize_all(git, &discovery.repos, options.threads);
    let total = start.elapsed();

    let mut timings: Vec<(Duration, String)> = results
        .iter()
        .map(|(elapsed, summary)| (*elapsed, summary.path.display().to_string()))
        .collect();
    timings.sort_by_key(|timing| std::cmp::Reverse(timing.0));
    timings.truncate(options.slowest);
    Run {
        discovery: discovered,
        summaries: total.saturating_sub(discovered),
        total,
        repos: results.len(),
        errors: results.iter().filter(|(_, s)| s.error.is_some()).count(),
        attention: results
            .iter()
            .filter(|(_, s)| s.attention.needs_attention)
            .count(),
        issues: discovery.issues.len(),
        timings,
    }
}

/// Summarizes every repository on a pool of `threads` workers, like the
/// app's scanner, and records how long each summary took.
fn summarize_all(
    git: &Git,
    repos: &[DiscoveredRepo],
    threads: usize,
) -> Vec<(Duration, RepoSummary)> {
    let workers = threads.min(repos.len());
    let next = AtomicUsize::new(0);
    let results: Mutex<Vec<Option<(Duration, RepoSummary)>>> = Mutex::new(vec![None; repos.len()]);
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(repo) = repos.get(index) else { break };
                    let start = Instant::now();
                    let summary = summarize(git, repo);
                    let elapsed = start.elapsed();
                    results
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())[index] =
                        Some((elapsed, summary));
                }
            });
        }
    });
    results
        .into_inner()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .into_iter()
        .flatten()
        .collect()
}

fn report(options: &Options, runs: &[Run]) -> String {
    let last = runs.last();
    let roots: Vec<String> = options
        .roots
        .iter()
        .map(|root| json_string(&root.display().to_string()))
        .collect();
    let run_items: Vec<String> = runs
        .iter()
        .map(|run| {
            format!(
                "{{\"discoveryMs\":{},\"summariesMs\":{},\"totalMs\":{},\"repos\":{},\"errors\":{},\"attention\":{},\"issues\":{}}}",
                ms(run.discovery),
                ms(run.summaries),
                ms(run.total),
                run.repos,
                run.errors,
                run.attention,
                run.issues
            )
        })
        .collect();
    let slowest: Vec<String> = last
        .map(|run| run.timings.as_slice())
        .unwrap_or_default()
        .iter()
        .map(|(elapsed, path)| {
            format!("{{\"ms\":{},\"path\":{}}}", ms(*elapsed), json_string(path))
        })
        .collect();
    format!(
        "{{\"version\":1,\"threads\":{},\"roots\":[{}],\"repos\":{},\"runs\":[{}],\"slowest\":[{}]}}",
        options.threads,
        roots.join(","),
        last.map_or(0, |run| run.repos),
        run_items.join(","),
        slowest.join(",")
    )
}

fn ms(duration: Duration) -> String {
    format!("{:.1}", duration.as_secs_f64() * 1000.0)
}

fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if u32::from(c) < 0x20 => out.push_str(&format!("\\u{:04x}", u32::from(c))),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<Options, String> {
        parse_args(args.iter().map(|arg| arg.to_string()))
    }

    #[test]
    fn parses_roots_and_options() {
        let options = parse(&["--runs", "3", "--threads", "2", "--exclude", "x", "a", "b"])
            .expect("valid arguments");
        assert_eq!(options.runs, 3);
        assert_eq!(options.threads, 2);
        assert_eq!(options.roots.len(), 2);
        assert!(options.roots.iter().all(|root| root.is_absolute()));
        assert_eq!(options.excluded.len(), 1);
    }

    #[test]
    fn rejects_bad_arguments() {
        assert!(parse(&[]).is_err());
        assert!(parse(&["--runs", "0", "a"]).is_err());
        assert!(parse(&["--threads", "99", "a"]).is_err());
        assert!(parse(&["--fetch", "a"]).is_err());
        assert!(parse(&["a", "--runs"]).is_err());
    }

    #[test]
    fn json_strings_are_escaped() {
        assert_eq!(
            json_string("C:\\a \"b\"\n\u{1}"),
            "\"C:\\\\a \\\"b\\\"\\n\\u0001\""
        );
    }
}
