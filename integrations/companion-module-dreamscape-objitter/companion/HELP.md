## DREAMSCAPE Objitter

Controls **Objitter**, the immersive-audio object motion controller by DREAMSCAPE Inc.

- **Commands** are sent as **OSC over UDP** to Objitter's control input (default port `9000`, see Objitter → Setup → System → OSC control).
- **Feedback, variables and dropdown lists** come from the Objitter web server over **WebSocket** (`ws://host:8080/ws`, read-only). Turn it off in the connection settings to run OSC-only.

### Connection settings

| Field | Default | Notes |
| --- | --- | --- |
| Objitter host | `127.0.0.1` | IP or host name of the computer running Objitter |
| OSC control port | `9000` | Must match Objitter's OSC control port (`CONTROL_PORT`) |
| Web UI / WebSocket port | `8080` | Must match Objitter's web port (`PORT`) |
| Enable WebSocket feedback | on | Live state, variables, feedbacks, dropdowns, Show Lock, Library apply |

**Remote computer:** connecting by the Objitter computer's own IP address works out of the box. If you use a DNS name or alias that Objitter does not know (or go through NAT / port forwarding), add that name to `ALLOWED_HOSTS` on the Objitter computer (tray / menu bar app: Settings → Allowed host names), otherwise the WebSocket is refused with HTTP 403. If Objitter is set to local-only (`HOST=127.0.0.1`), only a Companion on the same computer can connect. If Objitter's OSC **Allowed IPs** list is set, add the Companion computer's IP.

### Actions

- **Transport:** START, STOP, START/STOP toggle, FREEZE on/off/toggle, RETURN (all objects home, optional fade), Undo
- **Tempo:** TAP, RESYNC, set BPM, nudge BPM, tempo multiplier, set speed (with ramp), nudge speed, crossfade time
- **Recall:** quick slot 1-32 (optional fade), preset by name (dropdown or typed name, optional fade)
- **Cues (GO list):** GO, BACK, standby next, set standby cue by number
- **Timecode / internal clock:** PLAY, PAUSE, PLAY/PAUSE toggle, REWIND, LOCATE `hh:mm:ss:ff`, timecode cue control on/off/toggle
- **Show Lock** on/off/toggle *(WebSocket)*
- **Session:** load (optionally including output settings), save
- **Objects** (targets `5`, `1-8`, `1-4,9`, `@group`, `all`): enable/disable, play/pause, motion mode, RETURN, center position, set any parameter (`range.x 0.5`, `timing.min 0.2`, …)
- **Library:** apply a motion library item to objects *(WebSocket)*

Toggle and nudge actions (FREEZE toggle, clock toggle, BPM/speed nudge, standby next, Show Lock toggle) need the WebSocket link because they depend on the current state.

### Show Lock

Objitter enforces Show Lock itself: transport, recall, GO and the internal clock keep working, while editing commands (object edits, session load, undo, timecode enable) are refused with a warning in the Objitter UI.

### Feedbacks

Connected / disconnected, running, stopped, frozen, Show Lock, slot active (last recalled), slot has a preset, preset active, cue is last fired, cue is standby, timecode running, timecode cue control enabled, session has unsaved changes.

### Variables

`connection`, `connection_error`, `version`, `running`, `frozen`, `speed`, `bpm`, `tempo_mult`, `transition`, `show_lock`, `last_preset`, `last_preset_modified`, `last_slot`, `session_name`, `session_modified`, `tc_enabled`, `tc_input`, `tc_trigger`, `tc_state`, `tc_running`, `timecode`, `cue_count`, `cue_current_number`, `cue_current_label`, `cue_standby_number`, `cue_standby_label`, `cue_next_number`, `cue_next_label`, `cue_next_in`, `slot_1` … `slot_32` (preset names).

Cue numbers are positions in Objitter's cue list (1 = first cue), the same numbers Objitter's `/objitter/standby n` uses.

### Presets

Ready-made buttons in the categories **Transport**, **Tempo**, **Slots**, **Cues** and **Timecode**. Labels use fixed text sizes and manual line breaks so words never wrap mid-word on a 72×72 button; transport and clock buttons have an icon on top and a short label below. Colours: Transport mint, Tempo violet, Cues yellow, Timecode sky blue.

- **Transport:** START (mint while running), STOP (red while stopped), TOGGLE → `RUNNING` / `STOPPED`, FREEZE → `FROZEN`, RETURN, LOCK → `LOCKED` (yellow), `LINK ONLINE` / `LINK OFFLINE`
- **Tempo:** TAP + BPM, RESYNC, `BPM +1` / `BPM −1`, BPM display, `SPEED +0.1` / `−0.1`, `SPEED → 1.0`, `TEMPO ×0.5` / `×1` / `×2` (tempo multiplier)
- **Slots:** `SLOT n` + preset name (`—` when empty, grey when assigned, mint when last recalled)
- **Cues:** `GO → n` + standby cue label, `CUE BACK`, `CUE NEXT`, `LAST CUE n` + label, `CUE 1`–`CUE 8` standby (mint = fired, yellow = standby)
- **Timecode:** CLOCK play/pause, PLAY, PAUSE, REWIND, `LOCATE 00:00:00`, `TC CUE` on/off + source, `TIMECODE` display

Buttons placed from an older version of these presets do not change when the module is updated; drag the presets again.

### Troubleshooting

- *Status "Connection failure"*: check host / web port, firewall (TCP 8080), and `ALLOWED_HOSTS` (HTTP 403). OSC commands are still sent.
- *Buttons do nothing*: check the OSC control port, Objitter's top bar `CTRL` indicator, the OSC **Allowed IPs** list and Setup → OSC log (denied packets show as `deny`).
