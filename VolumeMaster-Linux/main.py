#!/usr/bin/env python3
import sys
import os
import threading
import subprocess
import serial
import time
import json

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
APP_REFRESH_INTERVAL = 12000  # ms → 12 seconds
DEBOUNCE_THRESHOLD = 3        # % minimum change to trigger update
VOLUME_APPLY_DELAY = 80      # ms – time to wait after last change before applying volume

# -----------------------
# PipeWire helpers
# -----------------------
def set_volume(client_ids, volume: float):
    if not client_ids:
        return
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
# Robust PipeWire app detection
# -----------------------
def get_pipewire_clients_grouped():
    grouped = {}
    try:
        result = subprocess.run(
            ["pw-dump"], capture_output=True, text=True, check=True, timeout=10
        )
        data = json.loads(result.stdout)
        for obj in data:
            if obj.get("type") != "PipeWire:Interface:Node":
                continue
            props = obj.get("info", {}).get("props", {})
            app_name = props.get("application.name") or props.get("node.name")
            if not app_name or app_name in ("WirePlumber", "pipewire", "libcanberra", "pipewire-media-session"):
                continue
            media_class = props.get("media.class", "")
            if "Audio/Sink" not in media_class and "Stream/Output/Audio" not in media_class:
                continue
            node_id = obj["id"]
            grouped.setdefault(app_name, []).append(node_id)
    except Exception:
        return _fallback_get_clients()
    return grouped

def _fallback_get_clients():
    grouped = {}
    try:
        result = subprocess.run(["wpctl", "status"], capture_output=True, text=True)
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line or not line[0].isdigit():
                continue
            parts = line.split(None, 2)
            try:
                cid = int(parts[0].rstrip('.'))
                name = parts[1]
                if name not in ("WirePlumber", "pipewire", "libcanberra"):
                    grouped.setdefault(name, []).append(cid)
            except Exception:
                pass
    except Exception:
        pass
    return grouped

# -----------------------
# Serial worker with auto-reconnect
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
        values = [0] * self.count

        while self.running:
            try:
                ser = serial.Serial(self.port, self.baud, timeout=1)
                print(f"Serial connected: {self.port}")

                while self.running:
                    try:
                        if ser.in_waiting > 0:
                            line = ser.readline().decode('utf-8', errors="ignore").strip()
                            if "@" in line:
                                try:
                                    v_str, k_str = line.split("@")
                                    v = int(v_str.strip())
                                    k = int(k_str.strip()) - 1
                                    if 0 <= k < self.count and 0 <= v <= 100:
                                        if abs(v - values[k]) >= 2:
                                            values[k] = v
                                            self.pot_values.emit(values.copy())
                                except ValueError:
                                    continue
                        else:
                            time.sleep(0.01)
                    except serial.SerialException:
                        break
                    except Exception:
                        pass

                ser.close()
            except Exception as e:
                print(f"Serial connection failed: {e}. Retrying in 5 seconds...")
                time.sleep(5)

# -----------------------
# App selector dialog
# -----------------------
class AppSelectorDialog(QDialog):
    def __init__(self, parent, apps, selected):
        super().__init__(parent)
        self.setWindowTitle("Select Apps")
        self.resize(350, 450)
        self.selected = selected.copy()

        layout = QVBoxLayout(self)
        self.list = QListWidget()
        layout.addWidget(self.list)
        self.refresh(apps)

        btns = QHBoxLayout()
        refresh_btn = QPushButton("Refresh Apps")
        ok_btn = QPushButton("OK")
        refresh_btn.clicked.connect(lambda: self.refresh(get_pipewire_clients_grouped()))
        ok_btn.clicked.connect(self.accept)
        btns.addWidget(refresh_btn)
        btns.addWidget(ok_btn)
        layout.addLayout(btns)

    def refresh(self, apps):
        self.list.clear()
        for name in sorted(apps.keys()):
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
# Main window with rate-limited volume application
# -----------------------
class MainWindow(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle("VolumeMaster")
        self.resize(500, 650)

        self.settings = QSettings("VolumeMaster", "VolumeMaster")
        self.available_apps = {}
        self.last_values = [0] * NUM_POTS
        self.knob_apps = [[] for _ in range(NUM_POTS)]

        # Master knob
        self.master_knob = self.settings.value("master_knob", None)
        if self.master_knob == "None":
            self.master_knob = None
        elif self.master_knob is not None:
            self.master_knob = int(self.master_knob)

        # Rate limiting setup
        self.pending_volumes = [None] * NUM_POTS  # None or float (master) or tuple(volume, list[ids])
        self.timers = [QTimer(self) for _ in range(NUM_POTS)]
        for i, timer in enumerate(self.timers):
            timer.setSingleShot(True)
            timer.timeout.connect(lambda k=i: self._apply_pending_volume(k))

        layout = QVBoxLayout(self)

        # Master selector
        top = QHBoxLayout()
        top.addWidget(QLabel("Master Volume Knob:"))
        self.master_combo = QComboBox()
        self.master_combo.addItem("None", None)
        for i in range(NUM_POTS):
            self.master_combo.addItem(f"Knob {i + 1}", i)
        self.master_combo.setCurrentIndex(0 if self.master_knob is None else self.master_knob + 1)
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
        for text, slot in [("Save Profile", self.save_profile),
                           ("Load Profile", self.load_profile),
                           ("Delete Profile", self.delete_profile)]:
            btn = QPushButton(text)
            btn.clicked.connect(slot)
            prof.addWidget(btn)
        layout.addLayout(prof)

        self.load_settings()
        self.refresh_apps()

        self.timer = QTimer(self)
        self.timer.timeout.connect(self.refresh_apps)
        self.timer.start(APP_REFRESH_INTERVAL)

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
            self.update_app_label(i)

    def update_app_label(self, i):
        apps = self.knob_apps[i]
        self.app_labels[i].setText("Apps: " + (", ".join(apps) if apps else "None"))

    def save_master(self, idx):
        data = self.master_combo.itemData(idx)
        self.master_knob = data
        self.settings.setValue("master_knob", "None" if data is None else str(data))

    def save_profile(self):
        name, ok = QInputDialog.getText(self, "Save Profile", "Profile name:")
        if not ok or not name.strip():
            return
        name = name.strip()
        for i in range(NUM_POTS):
            self.settings.setValue(f"profile/{name}/knob/{i}", self.knob_apps[i])
        self.settings.setValue(f"profile/{name}/master",
                               "None" if self.master_knob is None else str(self.master_knob))

    def load_profile(self):
        names = sorted({
            k.split("/")[1] for k in self.settings.allKeys()
            if k.startswith("profile/") and k.count("/") >= 2
        })
        if not names:
            QMessageBox.information(self, "Profiles", "No saved profiles found.")
            return
        name, ok = QInputDialog.getItem(self, "Load Profile", "Select profile:", names, 0, False)
        if not ok:
            return
        for i in range(NUM_POTS):
            raw = self.settings.value(f"profile/{name}/knob/{i}")
            self.knob_apps[i] = self._normalize_apps(raw)
            self.update_app_label(i)
        mk = self.settings.value(f"profile/{name}/master")
        self.master_knob = None if mk == "None" else (int(mk) if mk else None)
        self.master_combo.setCurrentIndex(0 if self.master_knob is None else self.master_knob + 1)

    def delete_profile(self):
        names = sorted({
            k.split("/")[1] for k in self.settings.allKeys()
            if k.startswith("profile/") and k.count("/") >= 2
        })
        if not names:
            QMessageBox.information(self, "Delete Profile", "No profiles to delete.")
            return
        name, ok = QInputDialog.getItem(self, "Delete Profile", "Select profile:", names, 0, False)
        if not ok:
            return
        for key in self.settings.allKeys():
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
            self.update_app_label(knob)

    def update_pots(self, values):
        for i, val in enumerate(values):
            if abs(val - self.last_values[i]) < DEBOUNCE_THRESHOLD:
                continue

            # Update UI immediately
            self.last_values[i] = val
            self.labels[i].setText(f"Knob {i + 1}: {val}%")
            self.sliders[i].setValue(val)

            volume = pot_to_volume(val)

            # Cancel any pending timer for this knob
            self.timers[i].stop()

            if self.master_knob is not None and i == self.master_knob:
                self.pending_volumes[i] = volume
            else:
                client_ids = []
                for app in self.knob_apps[i]:
                    client_ids.extend(self.available_apps.get(app, []))
                if client_ids:
                    self.pending_volumes[i] = (volume, client_ids)
                else:
                    self.pending_volumes[i] = None
                    continue  # nothing to do

            # Schedule new application after delay
            self.timers[i].start(VOLUME_APPLY_DELAY)

    def _apply_pending_volume(self, knob):
        pending = self.pending_volumes[knob]
        if pending is None:
            return
        self.pending_volumes[knob] = None

        if self.master_knob is not None and knob == self.master_knob:
            set_master_volume(pending)
        else:
            volume, client_ids = pending
            set_volume(client_ids, volume)

# -----------------------
# Entry point
# -----------------------
def main():
    app = QApplication(sys.argv)

    icon_path = os.path.join(os.path.dirname(__file__), "icon.png")
    if os.path.exists(icon_path):
        app.setWindowIcon(QIcon(icon_path))

    app.setStyleSheet("""
        QWidget { background:#1e1e2e; color:#cdd6f4; font-family: Sans Serif; }
        QFrame { background:#313244; border-radius:8px; padding:8px; margin:4px; }
        QPushButton { background:#45475a; padding:8px; border-radius:6px; }
        QPushButton:hover { background:#585b70; }
        QLabel { padding:4px; }
    """)

    win = MainWindow()
    win.show()

    worker = SerialWorker(SERIAL_PORT, BAUD_RATE, NUM_POTS)
    thread = threading.Thread(target=worker.run, daemon=True)
    worker.pot_values.connect(win.update_pots)
    thread.start()

    rc = app.exec()
    worker.stop()
    sys.exit(rc)

if __name__ == "__main__":
    main()
