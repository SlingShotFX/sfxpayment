from flask import Flask, request, jsonify

app = Flask(__name__)

FILE_NAME = "account.txt"

@app.route("/append", methods=["POST"])
def append_number():
    data = request.get_json()

    if not data or "number" not in data:
        return jsonify({"error": "No number provided"}), 400

    number = data["number"].strip()  # Remove accidental whitespace

    # Check for duplicates
    try:
        with open(FILE_NAME, "r") as file:
            # Read all existing numbers (strip newlines and ignore empty lines)
            existing_numbers = {line.strip() for line in file if line.strip()}
    except FileNotFoundError:
        # File doesn't exist yet – no duplicates
        existing_numbers = set()

    if number in existing_numbers:
        return jsonify({"error": "account already exists"}), 400

    # Append the new number (ensuring it's on its own line)
    try:
        with open(FILE_NAME, "a") as file:
            file.write(f"{number}\n")

        return jsonify({
            "status": "success",
            "appended": number
        }), 200

    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/")
def home():
    return "Server running!"


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8154)