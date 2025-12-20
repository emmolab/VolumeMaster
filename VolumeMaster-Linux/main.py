#!/usr/bin/env python3
import sys
import os
import threading
import subprocess
import serial

from PySide6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QLabel,
    QPushButton, QListWidget, QListWidgetItem,
    QHBoxLayout, QDialog, QFrame, QComboBox,
    QSlider, QMessageBox, QInputDialog
)
from PySide6.QtCore import Signal, QObject, QTimer, Qt, QSettings
from PySide6.QtGui import QIcon

# -----------------------
# Configuration
# -----------------------
SERIAL_PORT = "/dev/ttyUSB0"
BAUD_RATE = 9600
NUM_POTS = 4
APP_REFRESH_INTERVAL = 4000  # ms

# -----------------------
# PipeWire helpers
# -----------------------
def set_volume(client_ids, volume: float):
    volume = max(0.0, min(volume, 1.0))
    for cid in client_ids:
        subprocess.run(
            ["wpctl", "set-volume", str(cid), f"{volume:.2f}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )

def set_master_volume(volume: float):
    volume = max(0.0, min(volume, 1.0))
    subprocess.run(
        ["wpctl", "set-volume", "@DEFAULT_AUDIO_SINK@", f"{volume:.2f}"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL
    )

def pot_to_volume(val: int) -> float:
    return val / 100.0

# -----------------------
# PipeWire app detection
# -----------------------
def get_pipewire_clients_grouped():
    grouped = {}
    try:
        result = subprocess.run(["wpctl", "status"], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line or not line[0].isdigit():
                continue
            parts = line.split(None, 2)
            try:
                cid = int(parts[0].strip("."))
                name = parts[1]
                if name not in ("WirePlumber", "pipewire", "libcanberra"):
                    grouped.setdefault(name, []).append(cid)
            except Exception:
                pass
    except Exception:
        pass
    return grouped

# -----------------------
# Serial worker
# -----------------------
class SerialWorker(QObject):
    pot_values = Signal(list)

    def __init__(self, port, baud, count):
        super().__init__()
        self.port = port
        self.baud = baud
        self.count = count
        self.running = True

    def stop(self):
        self.running = False

    def run(self):
        try:
            ser = serial.Serial(self.port, self.baud, timeout=1)
            print(f"Serial connected: {self.port}")
        except Exception as e:
            print(f"Serial error: {e}")
            return

        values = [0] * self.count

        while self.running:
            try:
                line = ser.readline().decode(errors="ignore").strip()
                if "@" not in line:
                    continue
                v, k = line.split("@")
                v = int(v)
                k = int(k) - 1
                if 0 <= k < self.count:
                    values[k] = v
                    self.pot_values.emit(values.copy())
            except Exception:
                pass

        ser.close()

# -----------------------
# App selector dialog
# -----------------------
class AppSelectorDialog(QDialog):
    def __init__(self, parent, apps, selected):
        super().__init__(parent)
        self.setWindowTitle("Select Apps")
        self.resize(300, 400)
        self.selected = selected.copy()

        layout = QVBoxLayout(self)
        self.list = QListWidget()
        layout.addWidget(self.list)
        self.refresh(apps)

        btns = QHBoxLayout()
        refresh = QPushButton("Refresh")
        ok = QPushButton("OK")
        refresh.clicked.connect(lambda: self.refresh(get_pipewire_clients_grouped()))
        ok.clicked.connect(self.accept)
        btns.addWidget(refresh)
        btns.addWidget(ok)
        layout.addLayout(btns)

    def refresh(self, apps):
        self.list.clear()
        for name in sorted(apps):
            item = QListWidgetItem(name)
            item.setCheckState(Qt.Checked if name in self.selected else Qt.Unchecked)
            self.list.addItem(item)

    def accept(self):
        self.selected = [
            self.list.item(i).text()
            for i in range(self.list.count())
            if self.list.item(i).checkState() == Qt.Checked
        ]
        super().accept()

# -----------------------
# Main window
# -----------------------
class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("VolumeMaster")
        self.resize(480, 620)

        self.settings = QSettings("VolumeMaster", "VolumeMaster")
        self.available_apps = {}
        self.last_values = [0] * NUM_POTS
        self.knob_apps = [[] for _ in range(NUM_POTS)]

        # Optional master knob
        self.master_knob = self.settings.value("master_knob", None)
        if self.master_knob == "None":
            self.master_knob = None
        elif self.master_knob is not None:
            self.master_knob = int(self.master_knob)

        layout = QVBoxLayout(self)

        # Master selector
        top = QHBoxLayout()
        top.addWidget(QLabel("Master Volume Knob:"))
        self.master_combo = QComboBox()
        self.master_combo.addItem("None", None)
        for i in range(NUM_POTS):
            self.master_combo.addItem(f"Knob {i + 1}", i)

        if self.master_knob is None:
            self.master_combo.setCurrentIndex(0)
        else:
            self.master_combo.setCurrentIndex(self.master_knob + 1)

        self.master_combo.currentIndexChanged.connect(self.save_master)
        top.addWidget(self.master_combo)
        layout.addLayout(top)

        self.labels = []
        self.sliders = []
        self.app_labels = []

        for i in range(NUM_POTS):
            frame = QFrame()
            frame.setFrameShape(QFrame.StyledPanel)
            fl = QVBoxLayout(frame)

            label = QLabel(f"Knob {i + 1}: 0%")
            slider = QSlider(Qt.Horizontal)
            slider.setRange(0, 100)
            slider.setEnabled(False)

            apps = QLabel("Apps: None")
            apps.setWordWrap(True)

            btn = QPushButton("Select Apps")
            btn.clicked.connect(lambda _, k=i: self.select_apps(k))

            fl.addWidget(label)
            fl.addWidget(slider)
            fl.addWidget(apps)
            fl.addWidget(btn)

            layout.addWidget(frame)

            self.labels.append(label)
            self.sliders.append(slider)
            self.app_labels.append(apps)

        # Profile buttons
        prof = QHBoxLayout()
        save = QPushButton("Save Profile")
        load = QPushButton("Load Profile")
        delete = QPushButton("Delete Profile")

        save.clicked.connect(self.save_profile)
        load.clicked.connect(self.load_profile)
        delete.clicked.connect(self.delete_profile)

        prof.addWidget(save)
        prof.addWidget(load)
        prof.addWidget(delete)
        layout.addLayout(prof)

        self.load_settings()

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh_apps)
        self.timer.start(APP_REFRESH_INTERVAL)

    # -----------------------
    # Helpers
    # -----------------------
    def _normalize_apps(self, value):
        if value is None:
            return []
        if isinstance(value, list):
            return value
        if isinstance(value, str):
            return [value]
        try:
            return list(value)
        except Exception:
            return []

    # -----------------------
    # Persistence
    # -----------------------
    def load_settings(self):
        for i in range(NUM_POTS):
            raw = self.settings.value(f"knob/{i}/apps")
            apps = self._normalize_apps(raw)
            self.knob_apps[i] = apps
            self.app_labels[i].setText("Apps: " + (", ".join(apps) if apps else "None"))

    def save_master(self, idx):
        data = self.master_combo.itemData(idx)
        self.master_knob = data
        self.settings.setValue("master_knob", "None" if data is None else data)

    def save_profile(self):
        name, ok = QInputDialog.getText(self, "Save Profile", "Profile name:")
        if not ok or not name.strip():
            return
        name = name.strip()
        for i in range(NUM_POTS):
            self.settings.setValue(f"profile/{name}/knob/{i}", self.knob_apps[i])
        self.settings.setValue(
            f"profile/{name}/master",
            "None" if self.master_knob is None else self.master_knob
        )

    def load_profile(self):
        keys = self.settings.allKeys()
        names = sorted({
            k.split("/")[1]
            for k in keys
            if k.startswith("profile/") and k.count("/") >= 2
        })

        if not names:
            QMessageBox.information(self, "Profiles", "No saved profiles found.")
            return

        name, ok = QInputDialog.getItem(
            self, "Load Profile", "Select profile:", names, 0, False
        )
        if not ok:
            return

        for i in range(NUM_POTS):
            raw = self.settings.value(f"profile/{name}/knob/{i}")
            apps = self._normalize_apps(raw)
            self.knob_apps[i] = apps
            self.app_labels[i].setText("Apps: " + (", ".join(apps) if apps else "None"))

        mk = self.settings.value(f"profile/{name}/master")
        self.master_knob = None if mk == "None" else int(mk)
        self.master_combo.setCurrentIndex(
            0 if self.master_knob is None else self.master_knob + 1
        )

    def delete_profile(self):
        keys = self.settings.allKeys()
        names = sorted({
            k.split("/")[1]
            for k in keys
            if k.startswith("profile/") and k.count("/") >= 2
        })

        if not names:
            QMessageBox.information(self, "Delete Profile", "No profiles to delete.")
            return

        name, ok = QInputDialog.getItem(
            self, "Delete Profile", "Select profile to delete:", names, 0, False
        )
        if not ok:
            return

        for key in keys:
            if key.startswith(f"profile/{name}/"):
                self.settings.remove(key)

        QMessageBox.information(self, "Delete Profile", f"Profile '{name}' deleted.")

    # -----------------------
    # Runtime
    # -----------------------
    def refresh_apps(self):
        self.available_apps = get_pipewire_clients_grouped()

    def select_apps(self, knob):
        dlg = AppSelectorDialog(self, self.available_apps, self.knob_apps[knob])
        if dlg.exec():
            self.knob_apps[knob] = dlg.selected
            self.settings.setValue(f"knob/{knob}/apps", dlg.selected)
            self.app_labels[knob].setText(
                "Apps: " + (", ".join(dlg.selected) if dlg.selected else "None")
            )

    def update_pots(self, values):
        for i, val in enumerate(values):
            if val == self.last_values[i]:
                continue
            self.last_values[i] = val
            self.labels[i].setText(f"Knob {i + 1}: {val}%")
            self.sliders[i].setValue(val)

            if self.master_knob is not None and i == self.master_knob:
                set_master_volume(pot_to_volume(val))
            else:
                ids = []
                for app in self.knob_apps[i]:
                    ids.extend(self.available_apps.get(app, []))
                if ids:
                    set_volume(ids, pot_to_volume(val))

# -----------------------
# Entry point
# -----------------------
def main():
    app = QApplication(sys.argv)

    # -----------------------
    # Set app icon
    # -----------------------
    icon_path = os.path.join(os.path.dirname(__file__), "icon.png")  # put your icon here
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))

    app.setStyleSheet("""
        QWidget { background:#1e1e2e; color:#cdd6f4; }
        QFrame { background:#313244; border-radius:8px; padding:6px; }
        QPushButton { background:#45475a; padding:6px; border-radius:6px; }
        QPushButton:hover { background:#585b70; }
    """)

    win = MainWindow()
    win.show()

    worker = SerialWorker(SERIAL_PORT, BAUD_RATE, NUM_POTS)
    t = threading.Thread(target=worker.run, daemon=True)
    worker.pot_values.connect(win.update_pots)
    t.start()

    rc = app.exec()
    worker.stop()
    sys.exit(rc)

if __name__ == "__main__":
    main()
