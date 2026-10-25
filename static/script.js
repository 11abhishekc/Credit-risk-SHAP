"use strict";

/* ------------------------------------------------------------------ *
 *  Config
 * ------------------------------------------------------------------ */
// Same origin as the FastAPI app (static files are mounted on "/").
// Change to a full URL if the UI is ever hosted separately.
const API_URL = "/predict";

const MIN_SPINNER_MS = 450;     // avoids a flash when the API answers instantly
const SWEEP_MS = 1100;          // must match the needle/arc transition in CSS

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/* ------------------------------------------------------------------ *
 *  Field rules (must stay in line with the Pydantic model)
 * ------------------------------------------------------------------ */
const NUMERIC = {
  person_age:                 { label: "Age",                  type: "int",   min: 18, max: 100 },
  person_income:              { label: "Annual income",        type: "float", min: 1,  max: 1e9 },
  person_emp_length:          { label: "Employment length",    type: "float", min: 0,  max: 60 },
  cb_person_cred_hist_length: { label: "Credit history length",type: "int",   min: 0,  max: 60 },
  loan_amnt:                  { label: "Loan amount",          type: "float", min: 1,  max: 1e9 },
  loan_int_rate:              { label: "Interest rate",        type: "float", min: 0,  max: 40 },
};

const CHOICES = {
  person_home_ownership:     "home ownership",
  cb_person_default_on_file: "whether a default is on file",
  loan_grade:                "a loan grade",
  loan_intent:               "a loan purpose",
};

const PRESETS = {
  low: {
    person_age: 34, person_income: 85000, person_emp_length: 9, cb_person_cred_hist_length: 10,
    person_home_ownership: "MORTGAGE", cb_person_default_on_file: "N",
    loan_intent: "PERSONAL", loan_grade: "A", loan_amnt: 6000, loan_int_rate: 7.5,
  },
  high: {
    person_age: 22, person_income: 24000, person_emp_length: 0, cb_person_cred_hist_length: 2,
    person_home_ownership: "RENT", cb_person_default_on_file: "Y",
    loan_intent: "MEDICAL", loan_grade: "E", loan_amnt: 15000, loan_int_rate: 17.5,
  },
};

/* ------------------------------------------------------------------ *
 *  Elements
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);

const form       = $("app-form");
const submitBtn  = $("submit-btn");
const btnLabel   = submitBtn.querySelector(".btn-label");
const clearBtn   = $("clear-btn");

const panel      = $("result");
const needle     = $("g-needle");
const cutMark    = $("g-cut");
const valueArc   = $("g-value");
const zoneLow    = $("zone-low");
const zoneHigh   = $("zone-high");
const probBig    = $("prob-big");
const verdict    = $("verdict");
const verdictTxt = $("verdict-text");
const statCutoff = $("stat-cutoff");
const statMargin = $("stat-margin");
const resultNote = $("result-note");
const errorBox   = $("error-box");
const historyBox = $("history");
const historyList= $("history-list");

const DEFAULT_NOTE = resultNote.textContent;

/* ------------------------------------------------------------------ *
 *  Loan-to-income readout
 * ------------------------------------------------------------------ */
function loanRatio() {
  const income = parseFloat(form.person_income.value);
  const amount = parseFloat(form.loan_amnt.value);
  if (!(income > 0) || !(amount >= 0)) return null;
  // The model was trained on a 2-decimal ratio (e.g. 0.59), so match that.
  return Math.round((amount / income) * 100) / 100;
}

function updateRatio() {
  const income = parseFloat(form.person_income.value);
  const amount = parseFloat(form.loan_amnt.value);
  const r = loanRatio();

  if (r === null) {
    $("ratio-value").textContent = "—";
    $("ratio-raw").textContent = "—";
    $("ratio-fill").style.width = "0%";
    return;
  }
  const exact = (amount / income) * 100;
  $("ratio-value").textContent = (exact < 10 ? exact.toFixed(1) : Math.round(exact)) + "%";
  $("ratio-raw").textContent = r.toFixed(2);
  $("ratio-fill").style.width = Math.min(exact, 100) + "%";
}

form.person_income.addEventListener("input", updateRatio);
form.loan_amnt.addEventListener("input", updateRatio);

/* ------------------------------------------------------------------ *
 *  Validation
 * ------------------------------------------------------------------ */
function setError(name, message) {
  const err = $("err-" + name);
  const field = err.closest(".field");
  err.textContent = message || "";
  field.classList.toggle("invalid", Boolean(message));
  const input = form.elements[name];
  const first = input instanceof RadioNodeList ? input[0] : input;
  if (first) first.setAttribute("aria-invalid", message ? "true" : "false");
}

function clearErrors() {
  [...Object.keys(NUMERIC), ...Object.keys(CHOICES)].forEach((n) => setError(n, ""));
}

// Clear an error as soon as the person starts fixing it.
form.addEventListener("input", (e) => {
  const name = e.target.name;
  if (name && $("err-" + name)) setError(name, "");
});

function collect() {
  const errors = {};
  const payload = {};

  for (const [name, rule] of Object.entries(NUMERIC)) {
    const raw = form.elements[name].value.trim();
    if (raw === "") { errors[name] = `Enter ${rule.label.toLowerCase()}.`; continue; }

    const value = Number(raw);
    if (!Number.isFinite(value)) { errors[name] = "Enter a number."; continue; }
    if (rule.type === "int" && !Number.isInteger(value)) { errors[name] = "Use a whole number."; continue; }
    if (value < rule.min || value > rule.max) {
      errors[name] = `${rule.label} must be between ${rule.min.toLocaleString()} and ${rule.max.toLocaleString()}.`;
      continue;
    }
    payload[name] = value;
  }

  for (const [name, what] of Object.entries(CHOICES)) {
    const value = form.elements[name].value;
    if (!value) errors[name] = `Choose ${what}.`;
    else payload[name] = value;
  }

  if (!errors.person_income && !errors.loan_amnt) {
    payload.loan_percent_income = loanRatio();
  }

  return { payload, errors };
}

/* ------------------------------------------------------------------ *
 *  Gauge
 * ------------------------------------------------------------------ */
let shown = 0;          // value currently displayed in the big number (0–1)
let rafId = null;

const pct = (x) => (x * 100).toFixed(1) + "%";
const clamp01 = (x) => Math.min(1, Math.max(0, x));

function countTo(target) {
  cancelAnimationFrame(rafId);
  if (reducedMotion) { shown = target; probBig.textContent = pct(target); return; }

  const from = shown;
  const start = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);

  const tick = (now) => {
    const t = Math.min(1, (now - start) / SWEEP_MS);
    shown = from + (target - from) * ease(t);
    probBig.textContent = pct(shown);
    if (t < 1) rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);
}

function renderGauge(p, t) {
  const angle = (v) => -90 + clamp01(v) * 180;
  needle.style.transform  = `rotate(${angle(p)}deg)`;
  cutMark.style.transform = `rotate(${angle(t)}deg)`;
  valueArc.style.strokeDashoffset = String(100 - clamp01(p) * 100);

  const lowLen = clamp01(t) * 100;
  zoneLow.setAttribute("stroke-dasharray", `${lowLen} ${100 - lowLen}`);
  zoneHigh.setAttribute("stroke-dasharray", `0 ${lowLen} ${100 - lowLen} 0`);
}

function resetGauge() {
  cancelAnimationFrame(rafId);
  shown = 0;
  needle.style.transform = "rotate(-90deg)";
  cutMark.style.transform = "rotate(-90deg)";
  valueArc.style.strokeDashoffset = "100";
  zoneLow.setAttribute("stroke-dasharray", "0 100");
  zoneHigh.setAttribute("stroke-dasharray", "0 100");
  panel.dataset.state = "idle";
  verdict.dataset.state = "idle";
  verdictTxt.textContent = "Waiting for an application";
  probBig.textContent = "—";
  statCutoff.textContent = "—";
  statMargin.textContent = "—";
  resultNote.textContent = DEFAULT_NOTE;
}

function showResult(data, payload) {
  const p = Number(data.default_probability);
  const t = Number(data.threshold);
  const high = Number(data.default_prediction) === 1;
  const state = high ? "high" : "low";

  panel.dataset.state = state;
  verdict.dataset.state = state;
  verdictTxt.textContent = high ? "High risk" : "Low risk";
  verdict.classList.remove("pop");
  void verdict.offsetWidth;              // restart the pop animation
  verdict.classList.add("pop");

  renderGauge(p, t);
  countTo(p);

  const diff = (p - t) * 100;
  statCutoff.textContent = pct(t);
  statMargin.textContent = `${Math.abs(diff).toFixed(1)} pts ${diff >= 0 ? "above" : "below"}`;
  resultNote.textContent = Math.abs(diff) < 3
    ? "This is close to the cutoff, so small changes to the inputs could flip the result."
    : DEFAULT_NOTE;

  errorBox.hidden = true;
  addHistory(p, high, payload);
}

/* ------------------------------------------------------------------ *
 *  Session history
 * ------------------------------------------------------------------ */
const history = [];

function addHistory(p, high, payload) {
  history.unshift({ p, high, grade: payload.loan_grade, amount: payload.loan_amnt });
  history.length = Math.min(history.length, 5);

  historyList.replaceChildren(...history.map((h) => {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "h-dot " + (h.high ? "high" : "low");
    const desc = document.createElement("span");
    desc.className = "h-desc";
    desc.textContent = `Grade ${h.grade}, ${h.amount.toLocaleString()} loan`;
    const prob = document.createElement("span");
    prob.className = "h-prob";
    prob.textContent = pct(h.p);
    li.append(dot, desc, prob);
    return li;
  }));
  historyBox.hidden = false;
}

/* ------------------------------------------------------------------ *
 *  API
 * ------------------------------------------------------------------ */
async function requestPrediction(payload) {
  let res;
  try {
    res = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error("Couldn't reach the API. Check that the server is running, then try again.");
  }

  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      if (Array.isArray(body.detail)) {
        detail = body.detail
          .map((d) => `${(d.loc || []).slice(1).join(".") || "input"}: ${d.msg}`)
          .join("; ");
      } else if (typeof body.detail === "string") {
        detail = body.detail;
      }
    } catch { /* body wasn't JSON */ }

    if (res.status === 422) throw new Error(`The API rejected the input. ${detail}`);
    throw new Error(`The API couldn't score this application (HTTP ${res.status}). ${detail}`.trim());
  }
  return res.json();
}

function setBusy(busy) {
  submitBtn.setAttribute("aria-busy", String(busy));
  btnLabel.textContent = busy ? "Assessing" : "Assess risk";
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  clearErrors();
  errorBox.hidden = true;

  const { payload, errors } = collect();
  const failed = Object.keys(errors);
  if (failed.length) {
    failed.forEach((n) => setError(n, errors[n]));
    const el = form.elements[failed[0]];
    (el instanceof RadioNodeList ? el[0] : el).focus();
    return;
  }

  setBusy(true);
  try {
    const [data] = await Promise.all([
      requestPrediction(payload),
      new Promise((r) => setTimeout(r, MIN_SPINNER_MS)),
    ]);

    if (window.matchMedia("(max-width: 960px)").matches) {
      panel.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
    }
    showResult(data, payload);
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
  } finally {
    setBusy(false);
  }
});

/* ------------------------------------------------------------------ *
 *  Presets and clear
 * ------------------------------------------------------------------ */
function fill(values) {
  clearErrors();
  for (const [name, value] of Object.entries(values)) {
    const el = form.elements[name];
    if (el instanceof RadioNodeList) el.value = String(value);
    else el.value = String(value);
  }
  updateRatio();
}

document.querySelectorAll("[data-preset]").forEach((btn) => {
  btn.addEventListener("click", () => fill(PRESETS[btn.dataset.preset]));
});

clearBtn.addEventListener("click", () => {
  form.reset();
  clearErrors();
  updateRatio();
  errorBox.hidden = true;
  resetGauge();
});

/* ------------------------------------------------------------------ *
 *  Intro: one sweep of the needle on load, then rest
 * ------------------------------------------------------------------ */
if (!reducedMotion) {
  setTimeout(() => {
    needle.style.transform = "rotate(90deg)";
    setTimeout(() => { needle.style.transform = "rotate(-90deg)"; }, 900);
  }, 350);
}
