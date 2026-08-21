from flask import Flask, request, jsonify
from flask_cors import CORS
import os

app = Flask(__name__)

_raw_origins = os.getenv("CORS_ORIGINS", "*").strip()
if _raw_origins == "*":
    CORS(app)
else:
    CORS(app, origins=[origin.strip() for origin in _raw_origins.split(",") if origin.strip()])


def suggestion_for(payload: dict) -> str:
    state = payload.get("state")
    runway = payload.get("runwayDays")
    total_spent = float(payload.get("totalSpent") or 0)

    if state == "racing":
        if isinstance(runway, (int, float)) and runway < 21:
            days = max(1, round(runway))
            return f"Pulse is racing. At this rate the stack lasts about {days} days."
        return "Pulse is racing. A large share of this address's WPU is already on the move."
    if state == "dormant":
        if int(payload.get("personalBeats") or 0) == 0:
            return "No pulse yet. Every send is a beat — the wallet stays quiet until WPU moves."
        return "Pulse has gone quiet. Last beat was a while ago."
    if state == "still":
        return "Holding pattern. WPU has arrived, but this address has not sent a beat yet."
    if state == "steady":
        if isinstance(runway, (int, float)) and runway < 100000:
            return f"Steady pulse. Runway is about {round(runway)} days at the current send rate."
        return "Steady pulse. Sends are modest relative to what this address still holds."

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
    payload = dict(data)
    payload["totalSpent"] = total_spent
    return jsonify({"suggestion": suggestion_for(payload), "source": "pulse", "state": payload.get("state")})


if __name__ == "__main__":
    port = int(os.getenv("PORT", 5000))
    app.run(host="0.0.0.0", port=port)
