import json
import os
import socket
import subprocess
import time
import threading
from datetime import datetime, timedelta
import MetaTrader5 as mt5
from flask import Flask, request, jsonify
from flask_cors import CORS

app = Flask(__name__)
CORS(app)

# =========================
# CONSTANTS
# =========================
PORT_START = 5011
PORT_END = 5015
MAX_CLIENTS = 20
SFX_BASE_KEY = "sfx567"

MT5_PATH = r"C:\Users\kkayg\SFX\slingshotrobot\MetaTrader 5 1\terminal64.exe"
MT5_PATH1 = r"C:\Users\kkayg\SFX\slingshotrobot\ExoMarkets\1\MetaTrader 5 1\terminal64.exe"

ACCOUNT_FILE = "account.txt"
PORT_TRACK_FILE = "used_ports.json"

SMART_MONEY_URL = "http://localhost:5050"
TRADE_CONFIRMATION_MODE = "ask"
SYMBOL = "GOLD"

# ✅ NEW CONFIG FORMAT CONSTANTS
MASTER_URL = "http://localhost:5123"
FORWARD_TO_MASTER = True
MASTER_BALANCE = 10000

# =========================
# PORT MANAGEMENT
# =========================
def load_port_tracking():
    if os.path.exists(PORT_TRACK_FILE):
        try:
            with open(PORT_TRACK_FILE, 'r') as f:
                data = json.load(f)
                return {
                    'used_ports': set(data.get('used_ports', [])),
                    'port_account_map': data.get('port_account_map', {}),
                    'available_ports': set(range(PORT_START, PORT_END + 1)) - set(data.get('used_ports', []))
                }
        except (json.JSONDecodeError, IOError):
            pass

    all_ports = set(range(PORT_START, PORT_END + 1))
    return {
        'used_ports': set(),
        'port_account_map': {},
        'available_ports': all_ports
    }

def save_port_tracking(tracking_data):
    try:
        with open(PORT_TRACK_FILE, 'w') as f:
            json.dump({
                'used_ports': list(tracking_data['used_ports']),
                'port_account_map': tracking_data['port_account_map'],
                'last_updated': datetime.now().isoformat()
            }, f, indent=2)
    except IOError as e:
        print(f"Error saving port tracking: {e}")

port_tracking = load_port_tracking()
used_ports = port_tracking['used_ports']
available_ports = port_tracking['available_ports']
port_account_map = port_tracking['port_account_map']

def check_port_in_use(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        try:
            s.bind(('0.0.0.0', port))
            return False
        except socket.error:
            return True

def find_available_port():
    for port in sorted(available_ports):
        if port not in used_ports and not check_port_in_use(port):
            return port
    for port in range(PORT_START, PORT_END + 1):
        if port not in used_ports and not check_port_in_use(port):
            return port
    return None

def reserve_port(port, account_number):
    used_ports.add(port)
    if port in available_ports:
        available_ports.remove(port)
    port_account_map[str(port)] = str(account_number)
    save_port_tracking({
        'used_ports': used_ports,
        'port_account_map': port_account_map,
        'available_ports': available_ports
    })

def release_port(port):
    if port in used_ports:
        used_ports.remove(port)
        available_ports.add(port)
        port_account_map.pop(str(port), None)
        save_port_tracking({
            'used_ports': used_ports,
            'port_account_map': port_account_map,
            'available_ports': available_ports
        })

def get_config_file_for_port(port):
    config_file = f"config_server_{port}.json"
    if os.path.exists(config_file):
        return config_file
    return None

# =========================
# ACCOUNT FILE CHECK
# =========================
def is_account_in_file(account_number):
    account_str = str(account_number)

    if not os.path.exists(ACCOUNT_FILE):
        with open(ACCOUNT_FILE, 'w') as f:
            f.write("# List of valid accounts\n")
        return False

    try:
        with open(ACCOUNT_FILE, 'r') as f:
            for line in f:
                line = line.strip()
                if line.startswith('#') or not line:
                    continue
                if line == account_str:
                    return True
    except IOError:
        pass

    return False

# =========================
# MT5 HELPERS (IMPROVED)
# =========================
def connect_to_mt5(server, account, password, terminal_path=None, max_attempts=3):
    """
    Establish a connection to the MT5 terminal and log in to the broker.
    Uses single‑step initialization with login (like the second script).
    Retries up to `max_attempts` times.
    Returns (success, message/error).
    """
    if terminal_path is None:
        terminal_path = MT5_PATH   # fallback

    for attempt in range(1, max_attempts + 1):
        print(f"🔌 MT5 connection attempt {attempt}/{max_attempts}...")

        # Shutdown any existing connection before each attempt
        try:
            mt5.shutdown()
            time.sleep(1)
        except:
            pass

        # Initialize MT5 with login in one call (timeout=10000, portable=False)
        initialized = mt5.initialize(
            path=terminal_path,
            login=int(account),
            password=password,
            server=server,
            timeout=10000,
            portable=False
        )

        if not initialized:
            error = mt5.last_error()
            print(f"   ❌ Initialization failed: {error}")
            if attempt < max_attempts:
                print("   Retrying in 2 seconds...")
                time.sleep(2)
                continue
            else:
                return False, f"MT5 initialization failed after {max_attempts} attempts: {error}"

        # Verify that terminal and account info are available
        if mt5.terminal_info() is None or mt5.account_info() is None:
            print("   ❌ Connection verified but terminal/account info missing")
            mt5.shutdown()
            if attempt < max_attempts:
                print("   Retrying in 2 seconds...")
                time.sleep(2)
                continue
            else:
                return False, "MT5 initialized but connection not fully verified"

        # Success
        print("   ✅ MT5 login successful")
        return True, "Connected to broker"

    return False, "Unexpected error in connection loop"

def check_balance():
    info = mt5.account_info()
    if not info:
        return False, 0
    return info.balance > 10, info.balance

def get_account_info():
    info = mt5.account_info()
    if not info:
        return None
    return {
        "account": info.login,
        "balance": info.balance,
        "equity": info.equity,
        "leverage": info.leverage,
        "currency": info.currency,
        "server": info.server
    }

def generate_sfx_key(port):
    port_str = str(port)
    last_three = port_str[-3:].zfill(3)
    return f"{SFX_BASE_KEY}{last_three}"

def generate_server_name(port):
    return f"ProxyServer_{port}"

# =========================
# API ROUTES
# =========================
@app.route("/api/request-sfx-key", methods=["POST"])
def request_sfx_key():
    data = request.json or {}

    account = data.get("account")
    broker = data.get("broker")
    password = data.get("password")

    if not account or not broker or not password:
        return jsonify({"error": "Missing required fields"}), 400

    try:
        account_int = int(account)
    except ValueError:
        return jsonify({"error": "Account must be numeric"}), 400

    if not is_account_in_file(account_int):
        return jsonify({
            "success": False,
            "error": "Account not registered"
        }), 404

    assigned_port = find_available_port()
    if not assigned_port:
        return jsonify({"error": "Maximum clients reached"}), 429

    # Decide which MT5 terminal to use based on broker
    terminal_path = MT5_PATH1
    print(f"Selected terminal for broker '{broker}': {terminal_path}")

    # 🔌 Connect to MT5 (initialize + login) with retry
    success, msg = connect_to_mt5(broker, account_int, password, terminal_path, max_attempts=3)
    if not success:
        release_port(assigned_port)
        return jsonify({
            "error": msg,
            "details": "Check broker server name, account number, password, and ensure the correct MT5 terminal is used."
        }), 401

    ok, balance = check_balance()
    if not ok:
        mt5.shutdown()
        release_port(assigned_port)
        return jsonify({"error": "Account balance must be > $10"}), 402

    account_info = get_account_info()

    sfx_key = generate_sfx_key(assigned_port)
    server_name = generate_server_name(assigned_port)

    reserve_port(assigned_port, account_int)

    # ✅ NEW CONFIG FORMAT
    config = {
        "port": assigned_port,
        "account": account_int,
        "server": broker,
        "terminal_path": terminal_path,          # store the actual path used
        "password": password,
        "server_name": server_name,
        "master_url": MASTER_URL,
        "forward_to_master": FORWARD_TO_MASTER,
        "master_balance": MASTER_BALANCE,
        "comment": "German Auto",
        "start_paused": True,
        "sfx_key": sfx_key,
        "created_at": datetime.now().isoformat()
    }

    config_filename = f"config_server_{assigned_port}.json"
    with open(config_filename, "w") as f:
        json.dump(config, f, indent=2)

    mt5.shutdown()

    return jsonify({
        "success": True,
        "sfx_key": sfx_key,
        "account_info": account_info,
        "config_file": config_filename,
        "port": assigned_port,
        "config": config
    }), 200

# =========================
# (Optional) Test endpoint
# =========================
@app.route("/api/test-mt5-connection", methods=["POST"])
def test_mt5_connection():
    """
    Test MT5 connection without creating a config.
    Useful for debugging login issues.
    """
    data = request.json or {}
    account = data.get("account")
    broker = data.get("broker")
    password = data.get("password")

    if not account or not broker or not password:
        return jsonify({"error": "Missing required fields"}), 400

    try:
        account_int = int(account)
    except ValueError:
        return jsonify({"error": "Account must be numeric"}), 400

    # Determine terminal path
    terminal_path = MT5_PATH1 if "XM" in broker.upper() else MT5_PATH

    success, msg = connect_to_mt5(broker, account_int, password, terminal_path, max_attempts=3)
    if success:
        account_info = get_account_info()
        mt5.shutdown()
        return jsonify({
            "success": True,
            "message": "MT5 connection successful",
            "account_info": account_info
        }), 200
    else:
        return jsonify({
            "success": False,
            "error": msg
        }), 401

# =========================
# SERVER START
# =========================
if __name__ == "__main__":

    if not os.path.exists("logs"):
        os.makedirs("logs")

    if not os.path.exists(ACCOUNT_FILE):
        with open(ACCOUNT_FILE, 'w') as f:
            f.write("# List of valid accounts\n")

    # Optional: scan existing configs to update port tracking
    print("Scanning for existing configurations...")
    config_count = 0
    for filename in os.listdir('.'):
        if filename.startswith("config_server_") and filename.endswith(".json"):
            try:
                with open(filename, 'r') as f:
                    config = json.load(f)
                port = config.get("port")
                account = config.get("account")
                if port and account:
                    used_ports.add(port)
                    if port in available_ports:
                        available_ports.remove(port)
                    port_account_map[str(port)] = str(account)
                    config_count += 1
            except (json.JSONDecodeError, IOError):
                continue

    save_port_tracking({
        'used_ports': used_ports,
        'port_account_map': port_account_map,
        'available_ports': available_ports
    })

    print("=" * 60)
    print("SlingShotFX Backend Started (Port 1100)")
    print("=" * 60)
    print(f"Port Range: {PORT_START} → {PORT_END}")
    print(f"Max Clients: {MAX_CLIENTS}")
    print(f"Account Validation File: {ACCOUNT_FILE}")
    print(f"Found {config_count} existing configurations")
    print(f"Used ports: {sorted(list(used_ports))}")
    print(f"Available ports: {sorted(list(available_ports))}")
    print(f"Master URL: {MASTER_URL}")
    print("=" * 60)
    print("Available API Endpoints:")
    print("  POST /api/request-sfx-key - Request new SFX key")
    print("  POST /api/test-mt5-connection - Test MT5 login (debug)")
    print("=" * 60)

    app.run(host="0.0.0.0", port=1100, debug=True)