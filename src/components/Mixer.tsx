import { useEffect, useRef, useState } from "react";
import { api, type Track, type TrackPatch, type TrackPlugin, type Vst3Entry } from "../lib/api";
import { levelDb } from "../lib/audioEngine";
import { run, useUI, errText } from "../lib/store";

/** Audio mixer: per-track fader, pan, 3-band EQ, mute/solo, live meters. */
export function Mixer() {
  const view = useUI((s) => s.view);
  const tracks = view?.project.tracks.filter((t) => t.kind === "audio") ?? [];
  return (
    <div className="panel">
      <div className="panel-head"><span className="label">Mixer · <b>{tracks.length}</b></span></div>
      <div className="mixer" style={{ flex: 1, minHeight: 0 }}>
        {tracks.map((t) => <Strip key={t.id} t={t} />)}
        {!tracks.length && <div className="empty"><p>No audio tracks.</p></div>}
      </div>
    </div>
  );
}

function Strip({ t }: { t: Track }) {
  const [db, setDb] = useState(-90);
  const [draft, setDraft] = useState<TrackPatch>({});
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    let raf = 0;
    const tick = () => { setDb(levelDb(t.id)); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [t.id]);
  useEffect(() => setDraft({}), [t]);

  // Sliders patch locally, then commit one undoable edit after the drag settles.
  const patch = (p: TrackPatch) => {
    setDraft((d) => ({ ...d, ...p }));
    clearTimeout(timer.current);
    timer.current = setTimeout(() => run(api.updateTrack(t.id, p)), 220);
  };
  const v = { volume_db: t.volume_db ?? 0, pan: t.pan ?? 0, eq_low_db: t.eq_low_db ?? 0, eq_mid_db: t.eq_mid_db ?? 0, eq_high_db: t.eq_high_db ?? 0, ...draft };
  const h = Math.max(0, Math.min(100, ((db + 60) / 66) * 100));
  // Same bands as the export (render.rs: bass f=100, equalizer f=1000 w=1.5 octaves, treble f=8000).
  const eq = (k: "eq_low_db" | "eq_mid_db" | "eq_high_db", label: string, band: string) => (
    <>
      <span title={band}>{label}</span>
      <input type="range" min={-18} max={18} step={0.5} value={v[k]} aria-label={`${band} EQ`} title={`${band}: ${v[k].toFixed(1)} dB (double-click to reset)`} onChange={(e) => patch({ [k]: Number(e.target.value) })} onDoubleClick={() => patch({ [k]: 0 })} />
      <span className={`val ${v[k] ? "on" : ""}`}>{v[k] > 0 ? "+" : ""}{v[k] % 1 ? v[k].toFixed(1) : v[k]}</span>
    </>
  );
  return (
    <div className="strip" aria-label={`${t.name} channel strip`}>
      <div className="sname" title={t.name}>{t.name}</div>
      <div className="eq">{eq("eq_high_db", "H", "High shelf 8 kHz")}{eq("eq_mid_db", "M", "Mid bell 1 kHz")}{eq("eq_low_db", "L", "Low shelf 100 Hz")}</div>
      <FxBank t={t} />
      <div className="fader">
      <div className="fader-well">
      <input type="range" min={-60} max={12} step={0.5} value={v.volume_db} aria-label="Fader" onChange={(e) => patch({ volume_db: Number(e.target.value) })} onDoubleClick={() => patch({ volume_db: 0 })} />
      </div>
      <div className="meter" title={`${db.toFixed(1)} dBFS`}><div style={{ height: `${h}%` }} /></div>
      </div>
      <div className="pan"><input type="range" min={-1} max={1} step={0.05} value={v.pan} aria-label="Pan" title={`Pan ${v.pan === 0 ? "C" : v.pan < 0 ? `L${Math.round(-v.pan * 100)}` : `R${Math.round(v.pan * 100)}`}`} onChange={(e) => patch({ pan: Number(e.target.value) })} onDoubleClick={() => patch({ pan: 0 })} /></div>
      <div className="readout">{v.volume_db > 0 ? "+" : ""}{v.volume_db.toFixed(1)} dB</div>
      <div className="sm">
        <button className={`btn small ${t.muted ? "warn-on" : ""}`} onClick={() => run(api.updateTrack(t.id, { muted: !t.muted }))} aria-pressed={t.muted}>M</button>
        <button className={`btn small ${t.solo ? "solo-on" : ""}`} onClick={() => run(api.updateTrack(t.id, { solo: !t.solo }))} aria-pressed={!!t.solo}>S</button>
      </div>
    </div>
  );
}

/** Fixed number of insert slots per audio track. A plugin occupies one slot by
 *  its `slot` index (0–4); the others stay empty and clickable. */
const FX_SLOTS = 5;

/** Module-level cache of the VST3 scan, shared by every strip. */
let vst3List: Vst3Entry[] | null = null;
async function scanPlugins(): Promise<Vst3Entry[]> {
  if (!vst3List) vst3List = await api.vst3Scan().catch(() => [] as Vst3Entry[]);
  return vst3List;
}

const vst3Err = (e: unknown) => useUI.getState().toast("error", errText(e));

/** Five VST3 insert slots for a track. An empty slot opens a plugin picker; a
 *  filled slot's name opens the plugin's own editor, and a hover ✕ removes it.
 *  Editors are closed via the in-app "close" button (graceful vst3CloseEditor),
 *  not the window's WM button. */
function FxBank({ t }: { t: Track }) {
  const [picking, setPicking] = useState<number | null>(null);
  const [live, setLive] = useState<Set<string>>(new Set());
  const busy = useRef<Set<string>>(new Set());
  const vst3Editor = useUI((s) => s.vst3Editor);

  const list = t.plugins ?? [];
  const at = (i: number) => list.find((p) => p.slot === i) ?? null;

  const setLiveId = (id: string, on: boolean) =>
  setLive((prev) => {
    const next = new Set(prev);
    if (on) next.add(id); else next.delete(id);
    return next;
  });

  const ensureLoaded = async (p: TrackPlugin): Promise<boolean> => {
    if (live.has(p.id)) return true;
    try {
      await api.vst3Load(p.id, p.path ?? "", p.state ?? "");
      setLiveId(p.id, true);
      return true;
    } catch (e) {
      vst3Err(e);
      return false;
    }
  };

  const open = async (p: TrackPlugin) => {
    if (busy.current.has(p.id)) return;
    busy.current.add(p.id);
    try {
      if (!(await ensureLoaded(p))) return;
      // The crate allows one editor at a time; close the other first.
      if (vst3Editor && vst3Editor !== p.id) await api.vst3CloseEditor(vst3Editor).catch(() => {});
      await api.vst3OpenEditor(p.id);
      useUI.getState().set({ vst3Editor: p.id });
    } catch (e) {
      vst3Err(e);
    } finally {
      busy.current.delete(p.id);
    }
  };

  const close = async (p: TrackPlugin) => {
    await api.vst3CloseEditor(p.id).catch(() => {});
    if (vst3Editor === p.id) useUI.getState().set({ vst3Editor: null });
  };

  const remove = async (p: TrackPlugin) => {
    if (vst3Editor === p.id) useUI.getState().set({ vst3Editor: null });
    if (live.has(p.id)) await api.vst3Unload(p.id).catch(() => {});
    setLiveId(p.id, false);
    run(api.updateTrack(t.id, { plugins: list.filter((x) => x.id !== p.id) }));
  };

  const adopt = async (slot: number, entry: Vst3Entry) => {
    setPicking(null);
    const id = crypto.randomUUID();
    try {
      const info = await api.vst3Load(id, entry.path, "");
      setLiveId(id, true);
      const fx: TrackPlugin = { id, plugin_id: info.uid, label: info.name, path: entry.path, params: {}, state: "", enabled: true, slot };
      run(api.updateTrack(t.id, { plugins: [...list, fx] }));
    } catch (e) {
      vst3Err(e);
    }
  };

  return (
    <div className="fxbank" role="group" aria-label={`${t.name} insert slots`}>
    {Array.from({ length: FX_SLOTS }, (_, i) => {
      const p = at(i);
      return (
        <div className={`fxslot${p ? " filled" : ""}`} key={i}>
        {p ? (
          <>
          <button className={`fx-name${live.has(p.id) ? "" : " dim"}`} title="Open plugin editor" onClick={() => open(p)}>
          {p.label}
          </button>
          {vst3Editor === p.id && (
            <button className="btn small" title="Close plugin editor" onClick={() => close(p)}>close</button>
          )}
          <button className="fx-x" title="Remove plugin" aria-label={`Remove ${p.label}`} onClick={() => remove(p)}>✕</button>
          </>
        ) : (
          <button className="fx-empty" title="Choose a plugin" onClick={() => setPicking(i)}>+ FX</button>
        )}
        </div>
      );
    })}
    {picking !== null && <PluginPicker onPick={(e) => adopt(picking, e)} onClose={() => setPicking(null)} />}
    </div>
  );
}

/** Modal plugin picker. Lists every discovered VST3 plugin; selecting one loads
 *  it into the chosen slot. Reuses the app's `.scrim` / `.dialog` styling. */
function PluginPicker({ onPick, onClose }: { onPick: (e: Vst3Entry) => void; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [items, setItems] = useState<Vst3Entry[] | null>(null);
  useEffect(() => {
    let on = true;
    scanPlugins().then((l) => { if (on) setItems(l); });
    return () => { on = false; };
  }, []);
  const list = (items ?? []).filter((p) => p.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="scrim" onClick={onClose}>
    <div className="dialog" onClick={(e) => e.stopPropagation()}>
    <div className="dialog-head">
    <h2>Choose a plugin</h2>
    <span className="spacer" />
    <button className="btn icon" aria-label="Close" onClick={onClose}>✕</button>
    </div>
    <div className="dialog-body">
    <input className="input" placeholder="Filter plugins…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
    <div className="plugin-list">
    {!items && <p className="note">Scanning standard VST3 folders…</p>}
    {items && !list.length && (
      <p className="note">No plugins found. Install VST3 plugins in ~/.vst3 or /usr/lib/vst3, then restart.</p>
    )}
    {list.map((p) => (
      <button className="plugin-row" key={p.path} onClick={() => onPick(p)}>
      <span className="plugin-row-name">{p.name}</span>
      <span className="plugin-row-path">{p.path}</span>
      </button>
    ))}
    </div>
    </div>
    </div>
    </div>
  );
}
