//! VST3 plugin hosting (v5).
//!
//! One shared [`Vst3Host`] (process-lifetime, built lazily) loads plugins; live
//! instances live in `AppState::vst3`, keyed by the track slot id the UI
//! created. This module covers discovery, loading, parameter control, state
//! snapshots and plugin editors.
//!
//! Audio is not yet routed through a loaded chain (PR 2) — a plugin here is a
//! persisted, controllable, openable object, not (yet) an audible effect.
//!
//! Discovery deliberately does not call the crate's `discover_plugins()`: the
//! crate's docs warn that one malformed plugin can abort the whole process
//! during a scan. Instead we list `.vst3` entries with `std::fs`; a plugin is
//! dlopen'd only when the user explicitly loads it into a slot.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use serde::Serialize;
use tauri::State;
use uuid::Uuid;
use vst3_host::Vst3Host;

use crate::state::AppState;

/// PR 2 will take this from `project.settings.sample_rate`; 48 kHz is the
/// project default, so behaviour is identical until then.
const SAMPLE_RATE: f64 = 48_000.0;
const BLOCK: usize = 512;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParamInfo {
    pub id: u32,
    pub name: String,
    pub value: f64,
    pub can_automate: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoadedPlugin {
    pub name: String,
    pub uid: String,
    pub params: Vec<ParamInfo>,
}

static HOST: OnceLock<Mutex<Vst3Host>> = OnceLock::new();

fn host() -> &'static Mutex<Vst3Host> {
    HOST.get_or_init(|| {
        Mutex::new(
            Vst3Host::builder()
            .sample_rate(SAMPLE_RATE)
            .block_size(BLOCK)
            .build()
            .expect("failed to build the VST3 host"),
        )
    })
}

fn entry(p: &Path) -> Option<PluginEntry> {
    (p.extension().and_then(|x| x.to_str()) == Some("vst3")).then(|| PluginEntry {
        name: p.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
                                                                  path: p.to_string_lossy().into_owned(),
    })
}

fn scan_dir(dir: &Path, out: &mut Vec<PluginEntry>) {
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            if let Some(en) = entry(&e.path()) {
                out.push(en);
            }
        }
    }
}

/// Standard VST3 locations on this machine (existing directories only).
fn default_dirs() -> Vec<PathBuf> {
    let mut dirs = vec![PathBuf::from("/usr/lib/vst3"), PathBuf::from("/usr/local/lib/vst3")];
    if let Some(h) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.insert(0, h.join(".local/share/VST3"));
        dirs.insert(0, h.join(".vst3"));
    }
    #[cfg(target_os = "windows")]
    for var in ["ProgramFiles", "ProgramFiles(x86)"] {
        if let Some(pf) = std::env::var_os(var) {
            dirs.push(PathBuf::from(pf).join("Common Files").join("VST3"));
        }
    }
    #[cfg(target_os = "macos")]
    dirs.push(PathBuf::from("/Library/Audio/Plug-Ins/VST3"));
    dirs.into_iter().filter(|d| d.is_dir()).collect()
}

/// List VST3 plugins in the standard folders. Filesystem walk only — nothing
/// is dlopen'd here, so a broken plugin cannot take the app down at scan time.
#[tauri::command]
pub fn vst3_scan() -> Vec<PluginEntry> {
    let mut out = Vec::new();
    for dir in default_dirs() {
        scan_dir(&dir, &mut out);
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out.dedup_by(|a, b| a.path == b.path);
    out.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    out
}

/// Load `path` into slot `slot`. `saved` optionally restores a previously
/// persisted state blob (base64) so parameter tweaks survive a reload.
#[tauri::command]
pub fn vst3_load(state: State<AppState>, slot: Uuid, path: String, saved: Option<String>) -> Result<LoadedPlugin, String> {
    if state.vst3.lock().unwrap().contains_key(&slot) {
        return Err("slot already holds a plugin".into());
    }
    let mut plugin = host().lock().unwrap().load_plugin(&path).map_err(|e| e.to_string())?;
    if let Some(s) = saved.filter(|s| !s.is_empty()) {
        let bytes = base64::engine::general_purpose::STANDARD
        .decode(&s)
        .map_err(|e| format!("corrupt plugin state: {e}"))?;
        plugin.load_state(&bytes).map_err(|e| e.to_string())?;
    }
    let name = plugin.info().name.clone();
    let uid = plugin.info().uid.clone();
    let params = plugin.get_parameters().map_err(|e| e.to_string())?;
    let mut plist = Vec::with_capacity(params.len());
    for p in &params {
        let value = plugin.get_parameter(p.id).unwrap_or(0.0);
        plist.push(ParamInfo { id: p.id, name: p.name.clone(), value, can_automate: p.can_automate });
    }
    state.vst3.lock().unwrap().insert(slot, Arc::new(Mutex::new(plugin)));
    Ok(LoadedPlugin { name, uid, params: plist })
}

/// Set a parameter; returns the plugin's own display string for the value.
#[tauri::command]
pub fn vst3_set_param(state: State<AppState>, slot: Uuid, id: u32, value: f64) -> Result<String, String> {
    let live = state.vst3.lock().unwrap();
    let mut p = live.get(&slot).ok_or("no plugin loaded in this slot")?.lock().unwrap();
    let shown = p.format_parameter(id, value).ok();
    p.set_parameter(id, value).map_err(|e| e.to_string())?;
    Ok(shown.unwrap_or_else(|| format!("{value:.3}")))
}

/// Snapshot the plugin's state as a base64 blob for the project file.
#[tauri::command]
pub fn vst3_save_state(state: State<AppState>, slot: Uuid) -> Result<String, String> {
    let live = state.vst3.lock().unwrap();
    let p = live.get(&slot).ok_or("no plugin loaded in this slot")?.lock().unwrap();
    let blob = p.save_state().map_err(|e| e.to_string())?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&blob))
}

/// Open the plugin's own editor window. A background thread services it; one
/// editor at a time. The loop is transcribed from the crate's
/// `examples/editor_smoke.rs` — diff against that file in your local clone
/// before merging, since the window-service method names are the one part of
/// this module not yet exercised by your spike.
#[tauri::command]
pub fn vst3_open_editor(state: State<AppState>, slot: Uuid) -> Result<(), String> {
    let live = state.vst3.lock().unwrap().get(&slot).cloned().ok_or("no plugin loaded in this slot")?;
    if !live.lock().unwrap().has_editor() {
        return Err("this plugin has no editor".into());
    }
    if state.vst3_editor.lock().unwrap().is_some() {
        return Err("a plugin editor is already open; close it first".into());
    }
    let mut window = vst3_host::PluginWindow::new(live.clone());
    window.open().map_err(|e| e.to_string())?;
    let stop = Arc::new(AtomicBool::new(false));
    state.vst3_editor.lock().unwrap().replace((slot, stop.clone()));
    std::thread::spawn(move || {
        let mut next = Instant::now() + Duration::from_millis(16);
        while !stop.load(Ordering::Relaxed) {
            if window.service_platform_events().is_err() {
                break;
            }
            live.lock().unwrap().service_run_loop();
            let now = Instant::now();
            if next > now {
                std::thread::sleep(next - now);
            }
            next = Instant::now() + Duration::from_millis(16);
        }
        let _ = window.close();
    });
    Ok(())
}

#[tauri::command]
pub fn vst3_close_editor(state: State<AppState>, slot: Uuid) -> Result<(), String> {
    if let Some((s, stop)) = state.vst3_editor.lock().unwrap().take() {
        if s != slot {
            state.vst3_editor.lock().unwrap().replace((s, stop));
        } else {
            stop.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

/// Drop the live instance for `slot` (stops its editor thread if open). The
/// project entry, if any, is the UI's business.
#[tauri::command]
pub fn vst3_unload(state: State<AppState>, slot: Uuid) -> Result<(), String> {
    if let Some((s, stop)) = state.vst3_editor.lock().unwrap().take() {
        if s != slot {
            state.vst3_editor.lock().unwrap().replace((s, stop));
        } else {
            stop.store(true, Ordering::Relaxed);
        }
    }
    state.vst3.lock().unwrap().remove(&slot);
    Ok(())
}
