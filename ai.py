from flask import Flask, request, jsonify
from flask_cors import CORS
import os

app = Flask(__name__)

_raw_origins = os.getenv("CORS_ORIGINS", "*").strip()
if _raw_origins == "*":
    CORS(app)
else:
    CORS(app, origins=[origin.strip() for origin in _raw_origins.split(",") if origin.strip()])


def suggestion_for(total_spent: float) -> str:
    if total_spent > 50:
        return "You've spent a lot of WPU recently—consider saving some!"
    if total_spent > 20:
        return "Your spending is increasing—keep an eye on your budget!"
    return "Your spending looks good—keep it up!"


@app.route("/health", methods=["GET"])
def health():
    return jsonify({"ok": True})


@app.route("/analyze", methods=["POST"])
def analyze_spending():
    data = request.get_json(silent=True) or {}
    try:
        total_spent = float(data.get("totalSpent", 0))
    except (TypeError, ValueError):
        return jsonify({"error": "totalSpent must be a number"}), 400
    if total_spent < 0:
        return jsonify({"error": "totalSpent must be >= 0"}), 400
    return jsonify({"suggestion": suggestion_for(total_spent)})


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
