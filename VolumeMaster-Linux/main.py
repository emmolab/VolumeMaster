#!/usr/bin/env python3
import sys
import os
import threading
import serial
import time
import pulsectl
import queue
from PySide6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QLabel,
    QPushButton, QListWidget, QListWidgetItem,
    QHBoxLayout, QDialog, QFrame, QComboBox,
    QProgressBar, QMessageBox, QInputDialog, QGridLayout
)
from PySide6.QtCore import Signal, QObject, Qt, QSettings
from PySide6.QtGui import QIcon, QFont, QColor

# -----------------------
# Configuration
# -----------------------
SERIAL_PORT = "/dev/ttyUSB0"
BAUD_RATE   = 9600
NUM_POTS    = 4

# Accent colour per knob mode
ACCENT = {
    'master': '#89b4fa',
    'mic':    '#a6e3a1',
    'app':    '#cba6f7',
    'none':   '#45475a',
}


def _progress_style(color: str) -> str:
    return f"""
        QProgressBar {{
            background: #181825;
            border-radius: 2px;
            border: none;
        }}
        QProgressBar::chunk {{
            background: {color};
            border-radius: 2px;
        }}
    """


# -----------------------
# PulseAudio core
# -----------------------

class PulseCore:
    def __init__(self):
        self.pulse = pulsectl.Pulse('VolumeMaster-Core')
        self._lock  = threading.Lock()

    def apply_all(self, knob_apps, pot_values, master_knob, mic_knob):
        """Apply every knob's volume in a single PulseAudio round-trip for apps."""
        with self._lock:
            try:
                if master_knob is not None:
                    try:
                        sink = self.pulse.get_sink_by_name(
                            self.pulse.server_info().default_sink_name)
                        self.pulse.volume_set_all_chans(sink, pot_values[master_knob] / 100.0)
                    except Exception:
                        pass

                if mic_knob is not None:
                    try:
                        src = self.pulse.get_source_by_name(
                            self.pulse.server_info().default_source_name)
                        self.pulse.volume_set_all_chans(src, pot_values[mic_knob] / 100.0)
                    except Exception:
                        pass

                # Build app→volume map (one pass, no per-app IPC calls)
                app_vol = {}
                for k, apps in enumerate(knob_apps):
                    if k not in (master_knob, mic_knob):
                        for app in apps:
                            app_vol[app] = pot_values[k] / 100.0

                if app_vol:
                    for si in self.pulse.sink_input_list():
                        name = (si.proplist.get('application.name')
                                or si.proplist.get('media.name'))
                        if name in app_vol:
                            self.pulse.volume_set_all_chans(si, app_vol[name])
            except Exception:
                pass

    def get_apps(self):
        with self._lock:
            try:
                return sorted({
                    si.proplist.get('application.name') or si.proplist.get('media.name')
                    for si in self.pulse.sink_input_list()
                    if si.proplist.get('application.name') or si.proplist.get('media.name')
                })
            except Exception:
                return []


# -----------------------
# Off-thread volume worker
# -----------------------

class VolumeWorker:
    """Coalesces rapid pot updates and applies them off the main thread."""

    def __init__(self, pc: PulseCore):
        self.pc       = pc
        self._pending = None          # latest snapshot; None = nothing queued
        self._lock    = threading.Lock()
        self._event   = threading.Event()
        threading.Thread(target=self._run, daemon=True).start()

    def schedule(self, knob_apps, pot_values, master_knob, mic_knob):
        with self._lock:
            self._pending = (
                [list(a) for a in knob_apps],   # deep-copy so caller can mutate safely
                list(pot_values),
                master_knob,
                mic_knob,
            )
        self._event.set()

    def _run(self):
        while True:
            self._event.wait()
            self._event.clear()
            with self._lock:
                args, self._pending = self._pending, None
            if args:
                self.pc.apply_all(*args)


# -----------------------
# PulseAudio event monitor
# -----------------------

class FastMonitor(QObject):
    """Listens for new sink-input events and clamps volume immediately."""

    def __init__(self, state):
        super().__init__()
        self.state  = state
        self._queue = queue.Queue()
        threading.Thread(target=self._worker, daemon=True).start()

    def run(self):
        try:
            with pulsectl.Pulse('VolumeMaster-Monitor') as pulse:
                pulse.event_mask_set('sink_input')
                pulse.event_callback_set(lambda ev: self._queue.put(ev.index))
                while True:
                    pulse.event_listen()
        except Exception:
            pass

    def _clamp(self, p, index):
        for delay in [0, 0.02, 0.05, 0.1]:
            if delay:
                time.sleep(delay)
            try:
                si   = p.sink_input_info(index)
                name = (si.proplist.get('application.name')
                        or si.proplist.get('media.name'))
                if name:
                    for k, apps in enumerate(self.state['knob_apps']):
                        if name in apps:
                            target = self.state['pot_values'][k] / 100.0
                            if abs(si.volume.value_flat - target) > 0.01:
                                p.volume_set_all_chans(si, target)
                    return
            except Exception:
                return

    def _worker(self):
        with pulsectl.Pulse('VolumeMaster-Worker') as p:
            while True:
                self._clamp(p, self._queue.get())
                self._queue.task_done()


# -----------------------
# Custom widgets
# -----------------------

class ClickableLabel(QLabel):
    doubleClicked = Signal()
    def mouseDoubleClickEvent(self, _):
        self.doubleClicked.emit()


# -----------------------
# Main window
# -----------------------

class MainWindow(QWidget):
    def __init__(self, pc: PulseCore, vol_worker: VolumeWorker):
        super().__init__()
        self.pc         = pc
        self.vol_worker = vol_worker
        self.settings   = QSettings("VolumeMaster", "VolumeMaster")
        self.setWindowTitle("VolumeMaster")
        self.setMinimumSize(540, 560)

        icon_path = os.path.join(os.path.dirname(__file__), "icon.png")
        if os.path.exists(icon_path):
            self.setWindowIcon(QIcon(icon_path))

        self.state = {
            'knob_apps':   [[] for _ in range(NUM_POTS)],
            'knob_names':  [f"KNOB {i+1}" for i in range(NUM_POTS)],
            'pot_values':  [0] * NUM_POTS,
            'master_knob': None,
            'mic_knob':    None,
        }

        # Per-knob UI refs (populated in init_ui)
        self.pct_labels   = []
        self.progress_bars = []
        self.app_labels   = []
        self.title_labels = []
        self.mode_badges  = []
        self.assign_btns  = []

        self.init_ui()
        self.load_settings()

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def init_ui(self):
        root = QVBoxLayout(self)
        root.setContentsMargins(18, 14, 18, 14)
        root.setSpacing(10)

        # ── Header ──────────────────────────────────────────────────────
        hdr_row = QHBoxLayout()
        title = QLabel("VOLUMEMASTER")
        title.setFont(QFont("Sans Serif", 13, QFont.Bold))
        title.setStyleSheet("color: #a6adc8; letter-spacing: 5px;")
        self.status_label = QLabel("● DISCONNECTED")
        self.status_label.setStyleSheet("color: #f38ba8; font-size: 10px;")
        self.status_label.setAlignment(Qt.AlignRight | Qt.AlignVCenter)
        hdr_row.addWidget(title)
        hdr_row.addStretch()
        hdr_row.addWidget(self.status_label)
        root.addLayout(hdr_row)

        # ── Global controls (Master + Mic side-by-side) ─────────────────
        ctrl = QFrame()
        ctrl.setStyleSheet("background: #313244; border-radius: 10px;")
        cl = QHBoxLayout(ctrl)
        cl.setContentsMargins(14, 8, 14, 8)
        cl.setSpacing(10)

        for attr, text, slot in [
            ('master_combo', 'GLOBAL MASTER', self.save_master_config),
            ('mic_combo',    'MIC INPUT',     self.save_mic_config),
        ]:
            lbl = QLabel(text)
            lbl.setStyleSheet("color: #bac2de; font-weight: bold; font-size: 11px;")
            cb = QComboBox()
            cb.addItem("Disabled", None)
            for i in range(NUM_POTS):
                cb.addItem(f"Knob {i+1}", i)
            cb.currentIndexChanged.connect(slot)
            setattr(self, attr, cb)
            cl.addWidget(lbl)
            cl.addWidget(cb)
            cl.addStretch()

        root.addWidget(ctrl)

        # ── Knob cards (2 × 2 grid) ─────────────────────────────────────
        grid = QGridLayout()
        grid.setSpacing(10)

        for i in range(NUM_POTS):
            card = QFrame()
            card.setStyleSheet("background: #313244; border-radius: 12px;")
            cl = QVBoxLayout(card)
            cl.setContentsMargins(12, 10, 12, 10)
            cl.setSpacing(6)

            # Title row: knob name + mode badge
            top = QHBoxLayout()
            t = ClickableLabel(self.state['knob_names'][i])
            t.setStyleSheet("color: #9399b2; font-weight: bold; font-size: 11px;")
            t.setToolTip("Double-click to rename")
            t.doubleClicked.connect(lambda k=i: self.rename_knob(k))
            self.title_labels.append(t)

            badge = QLabel("—")
            badge.setAlignment(Qt.AlignCenter)
            badge.setFixedHeight(20)
            badge.setStyleSheet(
                "background: #45475a; color: #9399b2;"
                "border-radius: 10px; font-size: 9px; font-weight: bold; padding: 0 8px;"
            )
            self.mode_badges.append(badge)

            top.addWidget(t)
            top.addStretch()
            top.addWidget(badge)
            cl.addLayout(top)

            # Large percentage
            pct = QLabel("0%")
            pct.setAlignment(Qt.AlignCenter)
            pct.setFont(QFont("Sans Serif", 17, QFont.Bold))
            pct.setStyleSheet("color: #cdd6f4;")
            self.pct_labels.append(pct)
            cl.addWidget(pct)

            # Progress bar
            pb = QProgressBar()
            pb.setRange(0, 100)
            pb.setValue(0)
            pb.setTextVisible(False)
            pb.setFixedHeight(5)
            pb.setStyleSheet(_progress_style(ACCENT['none']))
            self.progress_bars.append(pb)
            cl.addWidget(pb)

            # App label
            al = QLabel("None assigned")
            al.setStyleSheet("color: #6c7086; font-size: 11px;")
            al.setWordWrap(True)
            al.setMinimumHeight(18)
            self.app_labels.append(al)
            cl.addWidget(al)

            # Assign button
            btn = QPushButton("ASSIGN APPS")
            btn.clicked.connect(lambda _, k=i: self.open_app_selector(k))
            self.assign_btns.append(btn)
            cl.addWidget(btn)

            grid.addWidget(card, i // 2, i % 2)

        root.addLayout(grid)

        # ── Profile bar ─────────────────────────────────────────────────
        p_card = QFrame()
        p_card.setStyleSheet("background: #181825; border-radius: 10px;")
        pl = QHBoxLayout(p_card)
        pl.setContentsMargins(10, 6, 10, 6)
        for label, slot, color in [
            ("SAVE",   self.save_profile,   "#a6e3a1"),
            ("LOAD",   self.load_profile,   "#89b4fa"),
            ("DELETE", self.delete_profile, "#f38ba8"),
        ]:
            b = QPushButton(label)
            b.setStyleSheet(
                f"color: {color}; font-weight: bold; background: transparent; border: none;"
            )
            b.clicked.connect(slot)
            pl.addWidget(b)

        root.addStretch()
        root.addWidget(p_card)

    # ------------------------------------------------------------------
    # Badge / mode helpers
    # ------------------------------------------------------------------

    def _get_mode(self, i: int) -> str:
        if i == self.state['master_knob']: return 'master'
        if i == self.state['mic_knob']:    return 'mic'
        if self.state['knob_apps'][i]:     return 'app'
        return 'none'

    def _update_badge(self, i: int):
        mode  = self._get_mode(i)
        color = ACCENT[mode]
        n     = len(self.state['knob_apps'][i])
        text  = {'master': 'MASTER', 'mic': 'MIC', 'none': '—'}.get(
                    mode, f"{n} APP{'S' if n != 1 else ''}")

        self.mode_badges[i].setText(text)
        self.mode_badges[i].setStyleSheet(
            f"background: #45475a; color: {color};"
            "border-radius: 10px; font-size: 9px; font-weight: bold; padding: 0 8px;"
        )
        self.progress_bars[i].setStyleSheet(_progress_style(color))
        self.assign_btns[i].setEnabled(mode not in ('master', 'mic'))

    def _update_all_badges(self):
        for i in range(NUM_POTS):
            self._update_badge(i)

    # ------------------------------------------------------------------
    # Settings persistence
    # ------------------------------------------------------------------

    def _clean_app_list(self, raw):
        if not raw:                    return []
        if isinstance(raw, str):       return [raw]
        if isinstance(raw, list):      return [str(a) for a in raw if a is not None]
        return []

    def load_settings(self):
        for i in range(NUM_POTS):
            raw  = self.settings.value(f"knob/{i}/apps") or self.settings.value(f"knob_{i}_apps")
            self.state['knob_apps'][i] = self._clean_app_list(raw)
            name = self.settings.value(f"knob/{i}/name", f"KNOB {i+1}")
            self.state['knob_names'][i] = name
            self.title_labels[i].setText(name)
            self.update_ui_labels(i)

        m = self.settings.value("master_knob")
        if m not in [None, "None"]:
            self.master_combo.setCurrentIndex(int(m) + 1)

        mic = self.settings.value("mic_knob")
        if mic not in [None, "None"]:
            self.mic_combo.setCurrentIndex(int(mic) + 1)

        self._update_all_badges()

    def update_ui_labels(self, i: int):
        apps = self.state['knob_apps'][i]
        self.app_labels[i].setText(", ".join(apps) if apps else "None assigned")

    # ------------------------------------------------------------------
    # Rename
    # ------------------------------------------------------------------

    def rename_knob(self, k: int):
        name, ok = QInputDialog.getText(
            self, "Rename Knob", "Enter name:", text=self.state['knob_names'][k])
        if ok and name.strip():
            self.state['knob_names'][k] = name.strip()
            self.title_labels[k].setText(name.strip())
            self.settings.setValue(f"knob/{k}/name", name.strip())

    # ------------------------------------------------------------------
    # Global combos
    # ------------------------------------------------------------------

    def save_master_config(self, idx: int):
        data = self.master_combo.itemData(idx)
        self.state['master_knob'] = data
        self.settings.setValue("master_knob", str(data) if data is not None else "None")
        self._update_all_badges()

    def save_mic_config(self, idx: int):
        data = self.mic_combo.itemData(idx)
        self.state['mic_knob'] = data
        self.settings.setValue("mic_knob", str(data) if data is not None else "None")
        self._update_all_badges()

    # ------------------------------------------------------------------
    # App selector
    # ------------------------------------------------------------------

    def open_app_selector(self, k: int):
        assigned = self.state['knob_apps'][k]

        dlg = QDialog(self)
        dlg.setWindowTitle(f"Assign Apps  —  {self.state['knob_names'][k]}")
        dlg.setFixedSize(420, 540)
        dl = QVBoxLayout(dlg)

        ql = QListWidget()

        def populate(keep_checked=None):
            running = self.pc.get_apps()
            checked = keep_checked if keep_checked is not None else assigned
            for a in sorted(set(running) | set(checked)):
                item = QListWidgetItem(a)
                item.setCheckState(Qt.Checked if a in checked else Qt.Unchecked)
                if a not in running:
                    item.setForeground(QColor("#6c7086"))
                    item.setToolTip("Not currently running")
                ql.addItem(item)

        def on_refresh():
            checked_now = [ql.item(i).text() for i in range(ql.count())
                           if ql.item(i).checkState() == Qt.Checked]
            ql.clear()
            populate(keep_checked=checked_now)

        populate()
        dl.addWidget(ql)

        btns = QHBoxLayout()
        ref = QPushButton("REFRESH"); ref.clicked.connect(on_refresh)
        ok  = QPushButton("CONFIRM"); ok.clicked.connect(dlg.accept)
        btns.addWidget(ref); btns.addWidget(ok)
        dl.addLayout(btns)

        if dlg.exec():
            selected = [ql.item(i).text() for i in range(ql.count())
                        if ql.item(i).checkState() == Qt.Checked]
            self.state['knob_apps'][k] = selected
            self.settings.setValue(f"knob/{k}/apps", selected)
            self.update_ui_labels(k)
            self._update_badge(k)

    # ------------------------------------------------------------------
    # Profiles
    # ------------------------------------------------------------------

    def save_profile(self):
        name, ok = QInputDialog.getText(self, "Save Profile", "Enter profile name:")
        if not ok: return
        name = name.strip()
        if not name or "/" in name:
            QMessageBox.warning(self, "VolumeMaster", "Invalid profile name.")
            return
        for i in range(NUM_POTS):
            self.settings.setValue(f"profile/{name}/knob/{i}/apps",  self.state['knob_apps'][i])
            self.settings.setValue(f"profile/{name}/knob/{i}/name",  self.state['knob_names'][i])
        self.settings.setValue(f"profile/{name}/master", self.state['master_knob'])
        self.settings.setValue(f"profile/{name}/mic",    self.state['mic_knob'])

    def load_profile(self):
        keys     = self.settings.allKeys()
        profiles = sorted({k.split("/")[1] for k in keys if k.startswith("profile/")})
        if not profiles:
            QMessageBox.information(self, "VolumeMaster", "No saved profiles found.")
            return
        name, ok = QInputDialog.getItem(self, "Load Profile", "Select profile:", profiles, 0, False)
        if not ok: return
        for i in range(NUM_POTS):
            raw  = self.settings.value(f"profile/{name}/knob/{i}/apps", [])
            self.state['knob_apps'][i]  = self._clean_app_list(raw)
            kname = self.settings.value(f"profile/{name}/knob/{i}/name", f"KNOB {i+1}")
            self.state['knob_names'][i] = kname
            self.title_labels[i].setText(kname)
            self.update_ui_labels(i)
        m = self.settings.value(f"profile/{name}/master")
        self.master_combo.setCurrentIndex(0 if m in [None, "None"] else int(m) + 1)
        mic = self.settings.value(f"profile/{name}/mic")
        self.mic_combo.setCurrentIndex(0 if mic in [None, "None"] else int(mic) + 1)
        self._update_all_badges()

    def delete_profile(self):
        keys     = self.settings.allKeys()
        profiles = sorted({k.split("/")[1] for k in keys if k.startswith("profile/")})
        if not profiles: return
        name, ok = QInputDialog.getItem(self, "Delete Profile", "Select profile:", profiles, 0, False)
        if ok:
            for k in [k for k in keys if k.startswith(f"profile/{name}/")]:
                self.settings.remove(k)

    # ------------------------------------------------------------------
    # Pot updates (from serial — main thread)
    # ------------------------------------------------------------------

    def update_pots(self, values: list):
        self.state['pot_values'] = values
        for i, v in enumerate(values):
            self.pct_labels[i].setText(f"{v}%")
            self.progress_bars[i].setValue(v)
        # Volume application is fully off-thread — no blocking on main thread
        self.vol_worker.schedule(
            self.state['knob_apps'],
            values,
            self.state['master_knob'],
            self.state['mic_knob'],
        )

    # ------------------------------------------------------------------
    # Serial status
    # ------------------------------------------------------------------

    def set_serial_status(self, connected: bool):
        if connected:
            self.status_label.setText("● CONNECTED")
            self.status_label.setStyleSheet("color: #a6e3a1; font-size: 10px;")
        else:
            self.status_label.setText("● DISCONNECTED")
            self.status_label.setStyleSheet("color: #f38ba8; font-size: 10px;")


# -----------------------
# Serial worker
# -----------------------

class SerialWorker(QObject):
    updated            = Signal(list)
    connection_changed = Signal(bool)

    def run(self):
        vals      = [0] * NUM_POTS
        connected = False
        while True:
            try:
                with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=0.1) as ser:
                    if not connected:
                        connected = True
                        self.connection_changed.emit(True)
                    while True:
                        line = ser.readline().decode(errors='ignore').strip()
                        if "@" in line:
                            try:
                                v, k = map(int, line.split("@"))
                                if 0 < k <= NUM_POTS and abs(v - vals[k-1]) > 1:
                                    vals[k-1] = v
                                    self.updated.emit(vals.copy())
                            except Exception:
                                continue
            except Exception:
                if connected:
                    connected = False
                    self.connection_changed.emit(False)
                time.sleep(1)


# -----------------------
# Entry point
# -----------------------

def main():
    app = QApplication(sys.argv)
    app.setStyleSheet("""
        QWidget {
            background: #1e1e2e;
            color: #cdd6f4;
            font-family: 'Segoe UI', Sans-Serif;
        }
        QPushButton {
            background: #313244;
            border-radius: 8px;
            padding: 8px 12px;
            font-weight: bold;
            border: none;
        }
        QPushButton:hover    { background: #45475a; }
        QPushButton:disabled { background: #313244; color: #45475a; }
        QComboBox {
            background: #313244;
            border: none;
            border-radius: 6px;
            padding: 4px 10px;
            min-width: 110px;
        }
        QComboBox::drop-down { border: none; }
        QComboBox QAbstractItemView {
            background: #313244;
            selection-background-color: #45475a;
            border: 1px solid #45475a;
            outline: none;
            padding: 4px;
        }
        QListWidget {
            background: #11111b;
            border: none;
            border-radius: 8px;
            padding: 4px;
        }
        QListWidget::item { padding: 4px 6px; border-radius: 4px; }
        QListWidget::item:hover { background: #313244; }
        QDialog { background: #1e1e2e; }
    """)

    pc         = PulseCore()
    vol_worker = VolumeWorker(pc)
    win        = MainWindow(pc, vol_worker)
    win.show()

    s_worker = SerialWorker()
    threading.Thread(target=s_worker.run, daemon=True).start()
    s_worker.updated.connect(win.update_pots)
    s_worker.connection_changed.connect(win.set_serial_status)

    m_worker = FastMonitor(win.state)
    threading.Thread(target=m_worker.run, daemon=True).start()

    sys.exit(app.exec())


if __name__ == "__main__":
    main()
