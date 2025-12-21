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
    QSlider, QMessageBox, QInputDialog, QGridLayout
)
from PySide6.QtCore import Signal, QObject, Qt, QSettings, QSize
from PySide6.QtGui import QIcon, QFont

# -----------------------
# Configuration
# -----------------------
SERIAL_PORT = "/dev/ttyUSB0"
BAUD_RATE = 9600
NUM_POTS = 4

class PulseCore:
    def __init__(self):
        self.pulse = pulsectl.Pulse('VolumeMaster-Core')
        self._lock = threading.Lock()

    def set_app_vol_bulk(self, app_name, vol_float):
        if not app_name: return
        with self._lock:
            try:
                for si in self.pulse.sink_input_list():
                    name = si.proplist.get('application.name') or si.proplist.get('media.name')
                    if name == app_name:
                        self.pulse.volume_set_all_chans(si, vol_float)
            except: pass

    def set_master_vol(self, vol_float):
        with self._lock:
            try:
                sink = self.pulse.get_sink_by_name(self.pulse.server_info().default_sink_name)
                self.pulse.volume_set_all_chans(sink, vol_float)
            except: pass

    def get_apps(self):
        with self._lock:
            try:
                return sorted({si.proplist.get('application.name') or si.proplist.get('media.name') 
                               for si in self.pulse.sink_input_list() if si.proplist.get('application.name')})
            except: return []

class FastMonitor(QObject):
    def __init__(self, state):
        super().__init__()
        self.state = state
        self.lazy_queue = queue.Queue()
        threading.Thread(target=self._lazy_worker, daemon=True).start()

    def run(self):
        try:
            with pulsectl.Pulse('VolumeMaster-Monitor') as pulse:
                pulse.event_mask_set('sink_input')
                pulse.event_callback_set(self._on_event)
                while True:
                    pulse.event_listen()
        except: pass

    def _on_event(self, ev):
        threading.Thread(target=self._instant_clamp, args=(ev.index,), daemon=True).start()

    def _instant_clamp(self, index):
        try:
            with pulsectl.Pulse('VolumeMaster-Instant') as p:
                si = p.sink_input_info(index)
                name = si.proplist.get('application.name') or si.proplist.get('media.name')
                if not name:
                    self.lazy_queue.put(index)
                    return
                for k_idx, apps in enumerate(self.state['knob_apps']):
                    if name in apps:
                        target = self.state['pot_values'][k_idx] / 100.0
                        if abs(si.volume.value_flat - target) > 0.01:
                            p.volume_set_all_chans(si, target)
        except: pass

    def _lazy_worker(self):
        with pulsectl.Pulse('VolumeMaster-Lazy') as p:
            while True:
                index = self.lazy_queue.get()
                for delay in [0.02, 0.05, 0.1]:
                    time.sleep(delay)
                    try:
                        si = p.sink_input_info(index)
                        name = si.proplist.get('application.name') or si.proplist.get('media.name')
                        if name:
                            for k_idx, apps in enumerate(self.state['knob_apps']):
                                if name in apps:
                                    p.volume_set_all_chans(si, self.state['pot_values'][k_idx] / 100.0)
                            break
                    except: break
                self.lazy_queue.task_done()

class MainWindow(QWidget):
    def __init__(self, pc):
        super().__init__()
        self.pc = pc
        self.settings = QSettings("VolumeMaster", "VolumeMaster")
        self.setWindowTitle("VolumeMaster")
        self.setMinimumSize(580, 720)
        
        icon_path = os.path.join(os.path.dirname(__file__), "icon.png")
        if os.path.exists(icon_path):
            self.setWindowIcon(QIcon(icon_path))
        
        self.state = {'knob_apps': [[] for _ in range(NUM_POTS)], 'pot_values': [0]*NUM_POTS, 'master_knob': None}
        self.init_ui()
        self.load_settings()

    def init_ui(self):
        main_layout = QVBoxLayout(self)
        main_layout.setContentsMargins(30, 30, 30, 30)
        main_layout.setSpacing(25)

        header = QLabel("VOLUMEMASTER")
        header.setFont(QFont("Sans Serif", 12, QFont.Bold))
        header.setAlignment(Qt.AlignCenter)
        header.setStyleSheet("color: #a6adc8; letter-spacing: 4px; margin-bottom: 10px;")
        main_layout.addWidget(header)

        m_frame = QFrame()
        m_frame.setStyleSheet("background: #313244; border-radius: 10px;")
        m_layout = QHBoxLayout(m_frame)
        m_label = QLabel("GLOBAL MASTER")
        m_label.setStyleSheet("color: #bac2de; font-weight: bold; padding-left: 5px;")
        self.master_combo = QComboBox()
        self.master_combo.addItem("Disabled", None)
        for i in range(NUM_POTS): self.master_combo.addItem(f"Knob {i + 1}", i)
        self.master_combo.currentIndexChanged.connect(self.save_master_config)
        m_layout.addWidget(m_label)
        m_layout.addStretch()
        m_layout.addWidget(self.master_combo)
        main_layout.addWidget(m_frame)

        grid = QGridLayout()
        grid.setSpacing(15)
        self.labels, self.sliders, self.app_labels = [], [], []

        for i in range(NUM_POTS):
            card = QFrame()
            card.setStyleSheet("background: #313244; border-radius: 12px; border: none;")
            cl = QVBoxLayout(card)
            cl.setContentsMargins(15, 15, 15, 15)

            h = QHBoxLayout()
            t = QLabel(f"KNOB {i+1}")
            t.setStyleSheet("color: #9399b2; font-weight: bold;")
            self.labels.append(QLabel("0%"))
            self.labels[i].setStyleSheet("color: #89b4fa; font-weight: bold;")
            h.addWidget(t); h.addStretch(); h.addWidget(self.labels[i])
            cl.addLayout(h)

            self.sliders.append(QSlider(Qt.Horizontal))
            self.sliders[i].setRange(0, 100); self.sliders[i].setEnabled(False)
            cl.addWidget(self.sliders[i])

            self.app_labels.append(QLabel("None assigned"))
            self.app_labels[i].setStyleSheet("color: #6c7086; font-size: 11px;")
            self.app_labels[i].setWordWrap(True); self.app_labels[i].setMinimumHeight(35)
            cl.addWidget(self.app_labels[i])

            btn = QPushButton("ASSIGN")
            btn.clicked.connect(lambda _, k=i: self.open_app_selector(k))
            cl.addWidget(btn)
            grid.addWidget(card, i // 2, i % 2)

        main_layout.addLayout(grid)

        p_card = QFrame()
        p_card.setStyleSheet("background: #181825; border-radius: 10px;")
        pl = QHBoxLayout(p_card)
        for t, s, c in [("SAVE", self.save_profile, "#a6e3a1"), 
                        ("LOAD", self.load_profile, "#f9e2af"), 
                        ("DELETE", self.delete_profile, "#f38ba8")]:
            b = QPushButton(t); b.setStyleSheet(f"color: {c}; font-weight: bold; background: transparent;")
            b.clicked.connect(s); pl.addWidget(b)
        main_layout.addStretch(); main_layout.addWidget(p_card)

    def _clean_app_list(self, raw):
        if not raw: return []
        if isinstance(raw, str): return [raw]
        if isinstance(raw, list): return [str(a) for a in raw if a is not None]
        return []

    def load_settings(self):
        for i in range(NUM_POTS):
            raw = self.settings.value(f"knob/{i}/apps") or self.settings.value(f"knob_{i}_apps")
            apps = self._clean_app_list(raw)
            self.state['knob_apps'][i] = apps
            self.update_ui_labels(i)
        m = self.settings.value("master_knob")
        if m not in [None, "None"]: self.master_combo.setCurrentIndex(int(m) + 1)

    def update_ui_labels(self, i):
        apps = self.state['knob_apps'][i]
        self.app_labels[i].setText(", ".join(apps) if apps else "None assigned")

    def save_master_config(self, idx):
        data = self.master_combo.itemData(idx)
        self.state['master_knob'] = data
        self.settings.setValue("master_knob", str(data) if data is not None else "None")

    def open_app_selector(self, k):
        apps = self.pc.get_apps()
        dlg = QDialog(self)
        dlg.setWindowTitle("Select Apps")
        dlg.setFixedSize(400, 500)
        dl = QVBoxLayout(dlg)
        ql = QListWidget()
        for a in apps:
            item = QListWidgetItem(a)
            item.setCheckState(Qt.Checked if a in self.state['knob_apps'][k] else Qt.Unchecked)
            ql.addItem(item)
        dl.addWidget(ql)
        btn = QPushButton("CONFIRM SELECTION")
        btn.clicked.connect(dlg.accept); dl.addWidget(btn)
        if dlg.exec():
            selected = [ql.item(i).text() for i in range(ql.count()) if ql.item(i).checkState() == Qt.Checked]
            self.state['knob_apps'][k] = selected
            self.settings.setValue(f"knob/{k}/apps", selected)
            self.update_ui_labels(k)

    def save_profile(self):
        name, ok = QInputDialog.getText(self, "Save", "Enter profile name:")
        if ok and name.strip():
            for i in range(NUM_POTS):
                self.settings.setValue(f"profile/{name}/knob/{i}", self.state['knob_apps'][i])
            self.settings.setValue(f"profile/{name}/master", self.state['master_knob'])

    def load_profile(self):
        keys = self.settings.allKeys()
        profiles = sorted({k.split("/")[1] for k in keys if k.startswith("profile/")})
        if not profiles:
            QMessageBox.information(self, "VolumeMaster", "No saved profiles found.")
            return
        name, ok = QInputDialog.getItem(self, "Load", "Select profile:", profiles, 0, False)
        if ok:
            for i in range(NUM_POTS):
                raw = self.settings.value(f"profile/{name}/knob/{i}", [])
                self.state['knob_apps'][i] = self._clean_app_list(raw)
                self.update_ui_labels(i)
            m = self.settings.value(f"profile/{name}/master")
            self.master_combo.setCurrentIndex(0 if m in [None, "None"] else int(m) + 1)

    def delete_profile(self):
        keys = self.settings.allKeys()
        profiles = sorted({k.split("/")[1] for k in keys if k.startswith("profile/")})
        if not profiles: return
        name, ok = QInputDialog.getItem(self, "Delete", "Select profile to remove:", profiles, 0, False)
        if ok:
            for k in keys:
                if k.startswith(f"profile/{name}/"): self.settings.remove(k)

    def update_pots(self, values):
        self.state['pot_values'] = values
        for i, v in enumerate(values):
            self.labels[i].setText(f"{v}%"); self.sliders[i].setValue(v)
            if i == self.state['master_knob']: self.pc.set_master_vol(v / 100.0)
            else:
                for app in self.state['knob_apps'][i]: self.pc.set_app_vol_bulk(app, v / 100.0)

class SerialWorker(QObject):
    updated = Signal(list)
    def run(self):
        vals = [0] * NUM_POTS
        while True:
            try:
                with serial.Serial(SERIAL_PORT, BAUD_RATE, timeout=0.1) as ser:
                    while True:
                        line = ser.readline().decode(errors='ignore').strip()
                        if "@" in line:
                            try:
                                v, k = map(int, line.split("@"))
                                if 0 < k <= NUM_POTS and abs(v - vals[k-1]) > 1:
                                    vals[k-1] = v; self.updated.emit(vals.copy())
                            except: continue
            except: time.sleep(1)

def main():
    app = QApplication(sys.argv)
    app.setStyleSheet("""
        QWidget { background: #1e1e2e; color: #cdd6f4; font-family: 'Segoe UI', Sans-Serif; }
        QPushButton { background: #45475a; border-radius: 6px; padding: 8px; font-weight: bold; border: none; }
        QPushButton:hover { background: #585b70; }
        QComboBox { background: #45475a; border: none; border-radius: 4px; padding: 4px 10px; min-width: 120px; }
        QComboBox::drop-down { border: none; }
        QComboBox QAbstractItemView { background: #313244; selection-background-color: #585b70; border: 1px solid #45475a; outline: none; padding: 5px; }
        QSlider::groove:horizontal { background: #181825; height: 4px; border-radius: 2px; }
        QSlider::handle:horizontal { background: #89b4fa; width: 12px; height: 12px; margin: -4px 0; border-radius: 6px; }
        QListWidget { background: #313244; border: none; border-radius: 8px; padding: 5px; }
    """)
    pc = PulseCore(); win = MainWindow(pc); win.show()
    s_worker = SerialWorker()
    threading.Thread(target=s_worker.run, daemon=True).start()
    s_worker.updated.connect(win.update_pots)
    m_worker = FastMonitor(win.state)
    threading.Thread(target=m_worker.run, daemon=True).start()
    sys.exit(app.exec())

if __name__ == "__main__":
    main()