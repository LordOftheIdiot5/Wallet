(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  root.WorldPulseMath = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const DAY = 86400;
  const WEEK = 7 * DAY;

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function suggestionFor(pulse) {
    if (pulse.state === "racing") {
      if (pulse.runwayDays != null && pulse.runwayDays < 21) {
        return `Pulse is racing. At this rate the stack lasts about ${Math.max(1, Math.round(pulse.runwayDays))} days.`;
      }
      return "Pulse is racing. A large share of this address's WPU is already on the move.";
    }
    if (pulse.state === "dormant") {
      if (pulse.personalBeats === 0) {
        return "No pulse yet. Every send is a beat — the wallet stays quiet until WPU moves.";
      }
      const days = pulse.daysSinceLast == null ? "a while" : `${Math.round(pulse.daysSinceLast)} days`;
      return `Pulse has gone quiet. Last beat was ${days} ago.`;
    }
    if (pulse.state === "still") {
      return "Holding pattern. WPU has arrived, but this address has not sent a beat yet.";
    }
    if (pulse.runwayDays != null && Number.isFinite(pulse.runwayDays)) {
      return `Steady pulse. Runway is about ${Math.round(pulse.runwayDays)} days at the current send rate.`;
    }
    return "Steady pulse. Sends are modest relative to what this address still holds.";
  }

  /**
   * Pulse is the heartbeat of WPU movement.
   * One beat = one outgoing transfer or burn (mints do not count).
   * BPM/state/runway are derived from those beats plus current balance.
   */
  function computePulse(input) {
    const now = input.now;
    const balance = Number(input.balance) || 0;
    const networkBeats = Number(input.networkBeats) || 0;
    const movements = Array.isArray(input.movements) ? input.movements : [];

    const sent = movements.filter((item) => item.direction === "sent" || item.direction === "burned");
    const received = movements.filter((item) => item.direction === "received");
    const sentTotal = sent.reduce((sum, item) => sum + Number(item.amount), 0);
    const receivedTotal = received.reduce((sum, item) => sum + Number(item.amount), 0);
    const firstSend = sent.length ? sent[0].timestamp : null;
    const lastSend = sent.length ? sent[sent.length - 1].timestamp : null;
    const recentBeats = sent.filter((item) => now - item.timestamp <= WEEK).length;
    const daysSinceLast = lastSend == null ? null : (now - lastSend) / DAY;
    const elapsedDays = firstSend == null ? 0 : Math.max((now - firstSend) / DAY, 1 / 24);
    const spendPerDay = sentTotal > 0 ? sentTotal / elapsedDays : 0;
    const runwayDays = spendPerDay > 0 ? balance / spendPerDay : null;
    const wealth = balance + sentTotal;
    const spendShare = wealth > 0 ? sentTotal / wealth : 0;

    let state = "dormant";
    if (sent.length === 0) {
      state = received.length > 0 ? "still" : "dormant";
    } else if (daysSinceLast != null && daysSinceLast > 14) {
      state = "dormant";
    } else if (spendShare >= 0.2 || (runwayDays != null && runwayDays < 21 && sentTotal >= 20)) {
      state = "racing";
    } else {
      state = "steady";
    }

    let bpm;
    if (state === "dormant") {
      bpm = 48;
    } else if (state === "still") {
      bpm = 56;
    } else if (state === "steady") {
      bpm = clamp(62 + recentBeats * 4, 60, 88);
    } else {
      bpm = clamp(100 + recentBeats * 6, 96, 136);
    }

    let score;
    if (state === "racing") {
      const penalty = runwayDays != null && runwayDays < 21 ? 21 - runwayDays : 0;
      score = clamp(38 - penalty, 10, 55);
    } else if (state === "dormant") {
      score = lastSend == null ? 22 : clamp(40 - daysSinceLast, 8, 40);
    } else if (state === "still") {
      score = 58;
    } else {
      score = clamp(70 + recentBeats * 3 - spendShare * 20, 55, 92);
    }

    const pulse = {
      state,
      bpm,
      score: Math.round(score),
      personalBeats: sent.length,
      recentBeats,
      networkBeats,
      sentTotal,
      receivedTotal,
      spendPerDay,
      spendShare,
      runwayDays,
      daysSinceLast,
    };
    pulse.suggestion = suggestionFor(pulse);
    return pulse;
  }

  return { computePulse, suggestionFor, DAY, WEEK };
});
