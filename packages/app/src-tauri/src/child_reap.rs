//! Fire-and-forget child processes that are always reaped.
//!
//! Dropping a `std::process::Child` does NOT wait for it. On Unix the exited
//! child then stays in the process table as a `<defunct>` zombie, parented to
//! this app, until the app itself exits. Sentinel is a long-running tray app,
//! so every un-waited spawn accumulates: users saw dozens to hundreds of
//! zombies under `Sentinel.app/Contents/MacOS/sentinel` after a day, one per
//! alert sound (`afplay`).
//!
//! `spawn_reaped` keeps the caller non-blocking by handing the `Child` to a
//! short-lived background thread that `wait()`s on it. Deliberately not a
//! global SIGCHLD handler: tokio's process driver owns SIGCHLD for the daemon
//! sidecar and the `kill` helpers, and a process-wide `waitpid(-1)` would
//! steal their exit statuses.

use std::io;
use std::process::{Child, Command};
use std::sync::{Arc, Mutex};

/// Spawn `cmd` and reap it on a background thread once it exits. Returns the
/// child's pid. The caller never blocks on the child's runtime.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn spawn_reaped(cmd: &mut Command) -> io::Result<u32> {
    let child = cmd.spawn()?;
    let pid = child.id();
    reap_in_background(child);
    Ok(pid)
}

/// Move an already-spawned `Child` onto a thread that waits for it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub fn reap_in_background(child: Child) {
    // The slot lets us take the child back if the thread cannot be created
    // (the closure, and anything moved into it, is dropped on that error).
    let slot = Arc::new(Mutex::new(Some(child)));
    let thread_slot = Arc::clone(&slot);
    let spawned = std::thread::Builder::new()
        .name("sentinel-child-reaper".into())
        .spawn(move || wait_slot(&thread_slot));
    if let Err(e) = spawned {
        // Thread creation failing means the process is near its resource
        // limits; block on the wait rather than leak a zombie.
        crate::app_log::app_log(&format!("child reaper thread failed to start: {e}"));
        wait_slot(&slot);
    }
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn wait_slot(slot: &Mutex<Option<Child>>) {
    let child = slot.lock().unwrap_or_else(|p| p.into_inner()).take();
    if let Some(mut child) = child {
        let _ = child.wait();
    }
}

/// Test support: the `ps` state of `pid` (`Z` for a zombie), or `None` when
/// the process table no longer has the pid, i.e. it was reaped.
#[cfg(all(test, unix))]
pub fn ps_state(pid: u32) -> Option<String> {
    let out = Command::new("ps")
        .args(["-o", "stat=", "-p", &pid.to_string()])
        .output()
        .expect("ps runs");
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

/// Test support: poll until `pid` leaves the process table, up to ~5 s.
#[cfg(all(test, unix))]
pub fn wait_until_gone(pid: u32) -> Option<String> {
    for _ in 0..100 {
        ps_state(pid)?;
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
    ps_state(pid)
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    /// Negative control: proves `ps_state` can see the leak this module
    /// exists to prevent. An exited child that nobody waits on is a zombie.
    #[test]
    fn unwaited_child_is_a_zombie() {
        let mut child = Command::new("true").spawn().expect("spawn true");
        let pid = child.id();
        let mut state = None;
        for _ in 0..100 {
            state = ps_state(pid);
            if state.as_deref().is_some_and(|s| s.starts_with('Z')) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        assert!(
            state.as_deref().is_some_and(|s| s.starts_with('Z')),
            "expected an unreaped child to show as a zombie, got {state:?}"
        );
        child.wait().expect("reap control child");
        assert_eq!(ps_state(pid), None);
    }

    #[test]
    fn spawn_reaped_leaves_no_zombie() {
        let pid = spawn_reaped(&mut Command::new("true")).expect("spawn true");
        assert_eq!(
            wait_until_gone(pid),
            None,
            "child {pid} was not reaped by spawn_reaped"
        );
    }

    #[test]
    fn spawn_reaped_does_not_block_the_caller() {
        let started = std::time::Instant::now();
        let pid = spawn_reaped(Command::new("sleep").arg("2")).expect("spawn sleep");
        assert!(
            started.elapsed() < std::time::Duration::from_secs(1),
            "spawn_reaped blocked for {:?}",
            started.elapsed()
        );
        // Still running, and not a zombie, right after the call returns.
        let state = ps_state(pid).expect("sleep is still running");
        assert!(!state.starts_with('Z'), "got {state}");
    }

    #[test]
    fn spawn_reaped_propagates_spawn_errors() {
        let err = spawn_reaped(&mut Command::new("/nonexistent/sentinel-no-such-bin"))
            .expect_err("spawning a missing binary must fail");
        assert_eq!(err.kind(), io::ErrorKind::NotFound);
    }
}
