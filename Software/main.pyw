import sys
import os
import yaml
import serial
import atexit
from pycaw.pycaw import AudioUtilities, ISimpleAudioVolume
import serial.tools.list_ports

def find_arduino_port():
    for port in serial.tools.list_ports.comports():
        if 'arduino' in port.description.lower():
            return port.device
    return ''

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

# Load config and initialize
config = load_config()
default_com = find_arduino_port()
serial_conn = setup_serial(config, default_com)

# Setup Voicemeeter if enabled
set_input_gain = set_output_gain = set_button_toggle = None
if str(config.get('vm')).lower() == 'true':
    print("Setting up Voicemeeter...")
    set_input_gain, set_output_gain, set_button_toggle = setup_voicemeeter(config)

atexit.register(lambda: vmr.logout() if veme else None)

# Map setup
mappings = {}
for key, val in config.get('Mappings', {}).items():
    try:
        index = int(key)
    except ValueError:
        print(f"Invalid mapping key: {key}")
        continue

    entry = {}

    # Handle ProcessNames (list)
    apps = val.get('ProcessNames')
    if isinstance(apps, list):
        entry['apps'] = [a.strip() for a in apps if isinstance(a, str) and a.strip()]

    # Handle VoiceMeeter (can be None or list)
    vm = val.get('VoiceMeeter')
    
    if config.get('vm') and vm is not None:
        if isinstance(vm, list):
            entry['vm'] = [v.strip() for v in vm if isinstance(v, str) and v.strip()]
        elif isinstance(vm, str):
            entry['vm'] = [vm.strip()]

    mappings[index] = entry
# Button mapping
buttons = {
    key: val.split(';') for key, val in config.get('Buttons', {}).items() if val
}

volumes = {k: 0 for k in mappings}
session_cache = {}
master_volume_interface = None

def setup_audio_interfaces():
    global session_cache, master_volume_interface
    sessions = AudioUtilities.GetAllSessions()
    session_cache.clear()

    for session in sessions:
        if session.Process:
            pid = session.Process.pid
            exe_name = session.Process.name()
            # Store by PID so multiple sessions from same exe are preserved
            session_cache[(pid, exe_name)] = session._ctl.QueryInterface(ISimpleAudioVolume)

    # Preload master volume interface if any mapping uses it
    if any('master' in entry.get('apps', []) for entry in mappings.values()):
        devices = AudioUtilities.GetSpeakers()
        interface = devices.Activate(IAudioEndpointVolume._iid_, CLSCTX_ALL, None)
        master_volume_interface = interface.QueryInterface(IAudioEndpointVolume)


def process_audio_change(index, value):
    sessions = AudioUtilities.GetAllSessions()
    mapping = mappings.get(index, {})
    volume_scalar = round(value / 100, 2)

    if 'apps' in mapping:
        for name in mapping['apps']:
            # Master volume
            if name.lower() == 'master' and master_volume_interface:
                master_volume_interface.SetMasterVolumeLevelScalar(volume_scalar, None)
                continue

            target_str = name.lower()
            for (pid, exe_name), session in list(session_cache.items()):
                if target_str in exe_name.lower():
                    try:
                        session.SetMasterVolume(volume_scalar, None)
                    except Exception:
                        pass  # Session disappeared mid-loop

    # Voicemeeter targets
    if 'vm' in mapping:
        for target in mapping['vm']:
            if target.lower().startswith('input'):
                set_input_gain(target.strip('Input'), value)
            elif target.lower().startswith('output'):
                set_output_gain(target.strip('Output'), value)

def main():
    call_counter = 0
    while True:
        try:
            line = serial_conn.readline().decode().strip()
        except:
            sys.exit("Serial disconnect error.")

        if '@' in line:
            try:
                value_str, index_str = line.split('@')
                value, index = int(value_str), int(index_str)
            except ValueError:
                print("Malformed input:", line)
                continue

            if index in volumes and value != volumes[index]:
                volumes[index] = value
                process_audio_change(index, value)

        elif veme:
            if line.endswith('!='):
                set_button_toggle(line.strip('!='), False)
            else:
                set_button_toggle(line.strip('='), True)

if __name__ == "__main__":
    main()
