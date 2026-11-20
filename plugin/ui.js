// The panel page. It only talks to window.popnow (preload.js); prices, runs and Resolve calls all
// happen in the main process. Rule of the button: the price is on it, and nothing starts until it
// is clicked.
(() => {
  "use strict";

  const api = window.popnow;
  const $ = (id) => document.getElementById(id);
  const app = $("app");
  const go = $("go");
  const statusBox = $("status");
  const stopBtn = $("stop");
  const getCreditsBtn = $("get-credits");
  const consentRow = $("consent-row");
  const consentBox = $("consent");

  const state = {
    actions: [],
    tab: "clip",
    chosen: { clip: "edit-video", frame: "edit-frame", text: "text-to-video" },
    values: {},
    quote: null,
    busy: null, // "price" | "run"
    balance: undefined,
  };

  const fmt = (n) => Number(n).toLocaleString("en-US");

  async function call(name, ...args) {
    const reply = await api[name](...args);
    if (reply && reply.ok === false) {
      if (reply.signIn) setPhase("out");
      const error = new Error(reply.error);
      error.signIn = Boolean(reply.signIn);
      throw error;
    }
    return reply ? reply.value : undefined;
  }

  function setPhase(phase) {
    app.dataset.phase = phase;
  }

  function setStatus(text, kind) {
    statusBox.textContent = "";
    statusBox.className = "status" + (kind ? " " + kind : "");
    if (!text) return;
    if (kind === "busy") {
      const spin = document.createElement("span");
      spin.className = "spinner";
      spin.setAttribute("aria-hidden", "true");
      statusBox.append(spin);
    }
    statusBox.append(document.createTextNode(text));
  }

  api.onStatus((text) => {
    if (state.busy) setStatus(text, "busy");
  });

  const action = () => state.actions.find((a) => a.id === state.chosen[state.tab]);

  function valuesFor(a) {
    if (!state.values[a.id]) {
      const v = {};
      for (const f of a.fields) if (f.default !== undefined) v[f.key] = f.default;
      state.values[a.id] = v;
    }
    return state.values[a.id];
  }

  function missingRequired(a) {
    const v = valuesFor(a);
    return a.fields.some((f) => f.required && !(typeof v[f.key] === "string" ? v[f.key].trim() : v[f.key]));
  }

  // ---- render ---------------------------------------------------------------------------------

  function renderBalance() {
    const el = $("balance");
    $("balance-text").textContent = state.balance === undefined ? "—" : `${fmt(state.balance)} credits`;
    el.classList.toggle("low", state.balance !== undefined && state.balance < 50);
  }

  function renderTabs() {
    for (const tab of document.querySelectorAll("[data-tab]")) {
      tab.setAttribute("aria-selected", String(tab.dataset.tab === state.tab));
    }
  }

  async function renderContext() {
    const box = $("context");
    box.className = "context";
    box.textContent = "";
    if (state.tab === "text") return;
    if (state.tab === "frame") {
      box.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.5" width="11" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="5" cy="6" r="1.2" fill="currentColor"/><path d="M3 10l3-2.5 2 1.5 3-2.5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg><span>Frame at the playhead</span>';
      return;
    }
    let ctx;
    try {
      ctx = await call("context");
    } catch (error) {
      ctx = { problem: error.message };
    }
    if (state.tab !== "clip") return;
    if (ctx.problem) {
      box.classList.add("problem");
      box.textContent = ctx.problem;
      return;
    }
    box.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><rect x="1.5" y="2.5" width="11" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M6 5.2v3.6L9 7z" fill="currentColor"/></svg>';
    const name = document.createElement("span");
    name.className = "clip-name";
    name.textContent = ctx.clip.name;
    const len = document.createElement("span");
    len.className = "len";
    len.textContent = `${ctx.clip.seconds.toFixed(1)} s`;
    box.append(name, len);
  }

  function renderChips() {
    const box = $("chips");
    box.textContent = "";
    for (const a of state.actions.filter((x) => x.source === state.tab)) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.setAttribute("role", "radio");
      chip.setAttribute("aria-checked", String(a.id === state.chosen[state.tab]));
      chip.textContent = a.title;
      if (a.free) {
        const free = document.createElement("span");
        free.className = "free";
        free.textContent = "Free";
        chip.append(free);
      }
      chip.addEventListener("click", () => {
        if (state.busy) return;
        state.chosen[state.tab] = a.id;
        resetQuote();
        renderAll();
      });
      box.append(chip);
    }
  }

  function renderFields() {
    const form = $("fields");
    form.textContent = "";
    const a = action();
    if (!a) return;
    const v = valuesFor(a);
    for (const f of a.fields) {
      if (f.kind === "toggle") {
        const row = document.createElement("label");
        row.className = "toggle";
        const text = document.createElement("span");
        text.textContent = f.label;
        const input = document.createElement("input");
        input.type = "checkbox";
        input.checked = v[f.key] !== false;
        input.addEventListener("change", () => {
          v[f.key] = input.checked;
          changed();
        });
        row.append(text, input);
        form.append(row);
        continue;
      }
      const label = document.createElement("label");
      label.className = "f";
      label.textContent = f.label;
      let input;
      if (f.kind === "select") {
        input = document.createElement("select");
        for (const o of f.options) {
          const opt = document.createElement("option");
          opt.value = o.value;
          opt.textContent = o.label;
          input.append(opt);
        }
        input.value = v[f.key] ?? f.options[0].value;
        input.addEventListener("change", () => {
          v[f.key] = input.value;
          changed();
        });
      } else {
        input = document.createElement("textarea");
        input.placeholder = f.placeholder || "";
        input.value = v[f.key] || "";
        input.addEventListener("input", () => {
          v[f.key] = input.value;
          changed();
        });
      }
      input.className = "field";
      input.name = f.key;
      label.append(input);
      form.append(label);
    }
    consentRow.hidden = !a.consent;
    consentRow.classList.remove("ask");
  }

  function renderButton() {
    const a = action();
    const q = state.quote;
    // Checking a price spins the button; a run keeps the button still and shows progress below it.
    go.dataset.busy = String(state.busy === "price");
    getCreditsBtn.hidden = true;
    stopBtn.hidden = state.busy !== "run";
    if (!a) return;
    if (state.busy) {
      go.disabled = true;
      if (state.busy === "run") go.textContent = "Making it…";
      return;
    }
    if (!q) {
      go.textContent = a.free ? "Create · Free" : "Get price";
      go.disabled = missingRequired(a);
      return;
    }
    const cost = q.free ? "Free" : `${fmt(q.credits)} credits`;
    go.textContent = "";
    if (q.wholeSourcePrice) {
      // Cutting the used part failed: say plainly the price is for the whole source file.
      const sub = document.createElement("span");
      sub.className = "sub";
      sub.textContent = "Priced on the whole source clip";
      go.append(document.createTextNode(`Create · ${cost}`), sub);
    } else if (q.seconds !== undefined && q.verb) {
      go.textContent = `${q.verb} · ${q.seconds.toFixed(1)} s · ${cost}`;
    } else {
      go.textContent = `Create · ${cost}`;
    }
    const needsTick = a.consent && !consentBox.checked;
    go.disabled = !q.affordable || needsTick;
    if (!q.affordable) getCreditsBtn.hidden = false;
  }

  function renderAll() {
    renderTabs();
    renderChips();
    renderFields();
    void renderContext();
    renderButton();
  }

  // ---- behaviour ------------------------------------------------------------------------------

  let textTimer;
  function resetQuote() {
    state.quote = null;
    clearTimeout(textTimer);
  }

  function changed() {
    resetQuote();
    setStatus("");
    renderButton();
    const a = action();
    // Text-only actions need no upload, so their price is checked as you type.
    if (a && a.source === "text" && !missingRequired(a)) {
      textTimer = setTimeout(() => void getPrice(), 700);
    }
  }

  async function getPrice() {
    const a = action();
    if (!a || state.busy) return null;
    state.busy = "price";
    renderButton();
    setStatus("Checking the price…", "busy");
    try {
      const q = await call("price", a.id, valuesFor(a));
      if (action() !== a) return null;
      state.quote = q;
      if (q.balance !== undefined) {
        state.balance = q.balance;
        renderBalance();
      }
      setStatus(q.affordable ? "" : `You have ${fmt(q.balance)} credits.`, q.affordable ? "" : "error");
      return q;
    } catch (error) {
      setStatus(error.message, "error");
      return null;
    } finally {
      state.busy = null;
      renderButton();
    }
  }

  async function create() {
    const q = state.quote;
    if (!q || state.busy) return;
    state.busy = "run";
    state.quote = null;
    renderButton();
    setStatus("Starting…", "busy");
    try {
      const result = await call("create", q.quoteId, { consent: consentBox.checked });
      state.busy = null;
      switch (result.kind) {
        case "done":
          setStatus(`Added to ${result.trackType === "audio" ? "A" : "V"}${result.track}`, "done");
          void refreshBalance();
          break;
        case "price_changed":
          state.quote = result.quote;
          setStatus(`The price changed to ${fmt(result.quote.credits)} credits. Nothing was charged.`, "error");
          break;
        case "needs_consent":
          // Nothing started. The user ticks the box themselves, then asks for the price again.
          consentRow.hidden = false;
          consentRow.classList.add("ask");
          setStatus("Tick the box above to go on. Nothing was charged.", "error");
          break;
        case "not_enough":
          state.quote = { ...q, affordable: false };
          setStatus("Not enough credits. Nothing was charged.", "error");
          break;
        case "stopped":
          setStatus(result.text, "");
          break;
        default:
          setStatus(result.text, "error");
      }
    } catch (error) {
      state.busy = null;
      setStatus(error.message, "error");
    } finally {
      state.busy = null;
      renderButton();
    }
  }

  async function refreshBalance() {
    try {
      state.balance = await call("balance");
    } catch {
      state.balance = undefined;
    }
    renderBalance();
  }

  go.addEventListener("click", async () => {
    const a = action();
    if (!a) return;
    if (!state.quote) {
      const q = await getPrice();
      if (q && q.free && a.free) await create();
      return;
    }
    await create();
  });
  consentBox.addEventListener("change", renderButton);
  stopBtn.addEventListener("click", () => void call("stopWaiting"));
  getCreditsBtn.addEventListener("click", () => void call("getCredits"));
  $("balance").addEventListener("click", () => void call("getCredits"));

  for (const tab of document.querySelectorAll("[data-tab]")) {
    tab.addEventListener("click", () => {
      if (state.busy) return;
      state.tab = tab.dataset.tab;
      resetQuote();
      setStatus("");
      renderAll();
    });
  }

  const menu = $("menu");
  const menuBtn = $("menu-btn");
  const closeMenu = () => {
    menu.hidden = true;
    menuBtn.setAttribute("aria-expanded", "false");
  };
  menuBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    menu.hidden = !menu.hidden;
    menuBtn.setAttribute("aria-expanded", String(!menu.hidden));
  });
  document.addEventListener("click", closeMenu);
  $("menu-library").addEventListener("click", () => void call("openLibrary"));
  $("menu-credits").addEventListener("click", () => void call("getCredits"));
  $("menu-sign-out").addEventListener("click", async () => {
    await call("logout").catch(() => undefined);
    setPhase("out");
  });

  $("sign-in").addEventListener("click", async () => {
    $("gate-error").textContent = "";
    setPhase("signing");
    try {
      await call("login");
      await enter();
    } catch (error) {
      setPhase("out");
      if (!/canceled/i.test(error.message)) $("gate-error").textContent = error.message;
    }
  });
  $("sign-in-cancel").addEventListener("click", () => void call("cancelLogin"));

  // The playhead moves while the panel is open; refresh what "Clip" points at when you come back.
  window.addEventListener("focus", () => {
    if (app.dataset.phase === "in" && !state.busy) void renderContext();
  });

  async function enter() {
    setPhase("in");
    renderAll();
    await refreshBalance();
  }

  async function boot() {
    state.actions = await call("actions");
    const status = await call("status");
    if (status.signedIn) await enter();
    else setPhase("out");
  }

  void boot().catch((error) => {
    setPhase("out");
    $("gate-error").textContent = error.message;
  });
})();
