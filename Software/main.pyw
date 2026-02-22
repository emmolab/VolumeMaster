import sys
import os
import yaml
import serial
import atexit
from pycaw.pycaw import AudioUtilities, ISimpleAudioVolume, IAudioEndpointVolume, AudioSession
from pycaw.constants import EDataFlow, ERole
from comtypes import CLSCTX_ALL
import serial.tools.list_ports
import time
from collections import deque
from ctypes import POINTER, cast
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler

class ConfigHandler(FileSystemEventHandler):
    def __init__(self, on_change):
        self.on_change = on_change
        self._last_triggered = 0

    def on_modified(self, event):
        if not event.src_path:
            return
        if event.src_path.endswith('config.yaml'):
            now = time.time()
            if now - self._last_triggered < 0.5:
                return
            self._last_triggered = now
            print('[Watcher] Config changed, reloading...')
            self.on_change()

def find_arduino_port():
    for port in serial.tools.list_ports.comports():
        if 'arduino' in port.description.lower():
            return port.device
    return ''

def watch_config(config_path, on_change):
    handler = ConfigHandler(on_change)
    observer = Observer()
    observer.schedule(handler, path=os.path.dirname(config_path), recursive=False)
    observer.start()
    return observer

def load_config():
    with open('config.yaml', 'r', encoding='UTF-8') as file:
        return yaml.safe_load(file)

def setup_serial(config, default_port):
    port = default_port if config['comport'] == 'COM' else config['comport']
    try:
        ser = serial.Serial(port)
    except serial.SerialException:
        sys.exit("Failed to open serial port.")
    ser.baudrate = config['baudrate']
    ser.bytesize = config['bytesize']
    ser.parity = config['parity']
    ser.stopbits = config['stopbits']
    return ser

# Voicemeeter setup
veme = 0
vmr = None
buttons = {}

def setup_voicemeeter(config):
    global vmr, veme
    import voicemeeter
    vmr = voicemeeter.remote(config['vmversion'])
    vmr.login()
    veme = 1

    def scalar_to_gain(value):
        value = int(value) / 100
        return (0.5 - value) * -120 if value < 0.5 else (value - 0.5) * 24 if value > 0.5 else 0

    def set_input_gain(index, value):
        vmr.inputs[int(index)].gain = int(scalar_to_gain(value))

    def set_output_gain(index, value):
        vmr.outputs[int(index)].gain = round(scalar_to_gain(value), 1)

    def set_button_toggle(srep, state):
        if srep not in buttons:
            return
        for action in buttons[srep]:
            kind, control = action.split('.')
            target = vmr.inputs if 'Input' in kind else vmr.outputs
            channel = target[int(kind.strip('InputOutput'))]
            setattr(channel, control.lower(), state)

    return set_input_gain, set_output_gain, set_button_toggle

def build_mappings(config):
    mappings = {}
    for key, val in config.get('Mappings', {}).items():
        try:
            index = int(key)
        except ValueError:
            print(f"Invalid mapping key: {key}")
            continue

        entry = {}

        apps = val.get('ProcessNames')
        if isinstance(apps, list):
            entry['apps'] = [a.strip() for a in apps if isinstance(a, str) and a.strip()]

        vm = val.get('VoiceMeeter')
        if vm:
            if isinstance(vm, list):
                entry['vm'] = [v.strip() for v in vm if isinstance(v, str) and v.strip()]
            elif isinstance(vm, str):
                entry['vm'] = [vm.strip()]

        mics = val.get('MicNames')
        if isinstance(mics, list):
            entry['mics'] = [m.strip() for m in mics if isinstance(m, str) and m.strip()]

        mappings[index] = entry
    return mappings

# Load config and initialize
config = load_config()
default_com = find_arduino_port()
serial_conn = setup_serial(config, default_com)

mappings = build_mappings(config)
buttons = {
    key: val.split(';') for key, val in config.get('Buttons', {}).items() if val
}
volumes = {k: 0 for k in mappings}

# Setup Voicemeeter if enabled
set_input_gain = set_output_gain = set_button_toggle = None
if config.get('vm'):
    set_input_gain, set_output_gain, set_button_toggle = setup_voicemeeter(config)

atexit.register(lambda: vmr.logout() if veme else None)

session_cache = {}
master_volume_interface = None
mic_interfaces = {}


def setup_mic_interfaces():
    global mic_interfaces
    mic_interfaces.clear()

    wanted = set()
    for entry in mappings.values():
        for name in entry.get('mics', []):
            wanted.add(name.lower())

    if not wanted:
        return

    capture_devices = AudioUtilities.GetAllDevices(
        data_flow=EDataFlow.eCapture.value, device_state=1
    )

    for device in capture_devices:
        try:
            friendly_name = device.FriendlyName.lower() if device.FriendlyName else ''
            for w in wanted:
                if w in friendly_name:
                    mic_interfaces[w] = device.EndpointVolume
                    break
        except Exception as e:
            print(f"Could not open mic device '{device.FriendlyName}': {e}")


def setup_audio_interfaces():
    global session_cache, master_volume_interface

    sessions = AudioUtilities.GetAllSessions()
    session_cache.clear()

    for session in sessions:
        if session.Process:
            pid = session.Process.pid
            exe_name = session.Process.name()
            session_cache[(pid, exe_name)] = session.SimpleAudioVolume

    if any('master' in entry.get('apps', []) for entry in mappings.values()):
        device = AudioUtilities.GetSpeakers()
        master_volume_interface = device.EndpointVolume

    setup_mic_interfaces()


def reload_config():
    global config, mappings, buttons, volumes
    print('[Watcher] Reloading config...')
    try:
        config = {}
        mappings = {}
        buttons = {}
        volumes = {}

        config = load_config()
        mappings = build_mappings(config)
        buttons = {
            key: val.split(';') for key, val in config.get('Buttons', {}).items() if val
        }
        volumes = {k: 0 for k in mappings}

        setup_audio_interfaces()
        print('[Watcher] Reloaded successfully.')
    except Exception as e:
        print(f'[Watcher] Failed to reload: {e}')


def process_audio_change(index, value):
    mapping = mappings.get(index, {})
    volume_scalar = round(value / 100, 2)

    if 'apps' in mapping:
        for name in mapping['apps']:
            if name.lower() == 'master' and master_volume_interface:
                master_volume_interface.SetMasterVolumeLevelScalar(volume_scalar, None)
                continue

            target_str = name.lower()
            for (pid, exe_name), vol_interface in list(session_cache.items()):
                if target_str in exe_name.lower():
                    try:
                        vol_interface.SetMasterVolume(volume_scalar, None)
                    except Exception:
                        pass

    if 'mics' in mapping:
        for mic_name in mapping['mics']:
            key = mic_name.lower()
            interface = mic_interfaces.get(key)
            if interface:
                try:
                    interface.SetMasterVolumeLevelScalar(volume_scalar, None)
                except Exception as e:
                    print(f"Failed to set mic volume for '{mic_name}': {e}")
            else:
                print(f"Mic not found in cache: '{mic_name}' — will retry on next refresh")

    if config.get('vm') and 'vm' in mapping:
        for target in mapping['vm']:
            if target.lower().startswith('input'):
                set_input_gain(target.strip('Input'), value)
            elif target.lower().startswith('output'):
                set_output_gain(target.strip('Output'), value)


def main():
    volumes = {}
    volume_cache = deque()
    last_update_time = 0
    timeSinceLastRefresh = time.time()
    update_interval = 0.00001
    timeSinceLastSerialInput = None

    setup_audio_interfaces()

    observer = watch_config(os.path.abspath('config.yaml'), reload_config)

    try:
        while True:
            now = time.monotonic()
            if volume_cache:
                if serial_conn.timeout != 0:
                    serial_conn.timeout = 0
            else:
                if serial_conn.timeout is not None:
                    serial_conn.timeout = None

            try:
                line = serial_conn.readline().decode().strip()
            except:
                sys.exit("Serial disconnect error.")

            if '@' in line:
                try:
                    value_str, index_str = line.split('@')
                    value, index = int(value_str), int(index_str)
                    timeSinceLastSerialInput = time.time()
                    volume_cache.append((index, value))
                except ValueError:
                    print("Malformed input:", line)
                    continue

            elif veme:
                if line.endswith('!='):
                    set_button_toggle(line.strip('!='), False)
                else:
                    set_button_toggle(line.strip('='), True)

            if now - last_update_time >= update_interval and volume_cache:
                while volume_cache:
                    if not volume_cache:
                        break
                    index, val = volume_cache.popleft()
                    if index not in volumes or volumes[index] != val:
                        volumes[index] = val
                        process_audio_change(index, val)
                    last_update_time = now

            if time.time() - timeSinceLastRefresh > 2:
                timeSinceLastRefresh = time.time()
                setup_audio_interfaces()

    finally:
        observer.stop()
        observer.join()


if __name__ == "__main__":
    main()