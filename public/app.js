"use strict";
(function () {
  const STAGES = ["intake", "planning", "plan_approval", "repo", "building", "reviewing", "ci", "provisioning", "deploy_approval", "deploying", "done"];
  const STAGE_LABEL = { intake: "Intake", planning: "Planning", plan_approval: "Plan approval", repo: "Repo", building: "Teams building",
    reviewing: "Validation", ci: "CI", provisioning: "Provisioning", deploy_approval: "Deploy approval", deploying: "Deploying", done: "Done" };
  const BUDGET = 5;
  const TIER_VAR = { free: "--t-free", cheap: "--t-cheap", sonnet: "--t-sonnet", opus: "--t-opus" };
  const view = document.getElementById("view");
  let timer = null;
  let logState = { taskId: null, since: 0, agent: "", lines: [] };

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const usd = (n, d = 2) => (typeof n === "number" ? "$" + n.toFixed(n !== 0 && Math.abs(n) < 0.01 ? 4 : d) : "–");
  const dur = (s) => { if (!s && s !== 0) return "–"; s = Math.max(0, Math.round(s)); if (s < 60) return s + "s"; const m = Math.floor(s / 60); if (m < 60) return m + "m " + (s % 60) + "s"; return Math.floor(m / 60) + "h " + (m % 60) + "m"; };
  const when = (ts) => ts ? new Date(ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "–";
  const clock = (ts) => ts ? new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "";
  const shortModel = (m) => (m || "?").split("/").pop();
  const nowS = () => Date.now() / 1000;
  const tierVar = (t) => `var(${TIER_VAR[t] || "--idle"})`;

  async function api(path) {
    const r = await fetch("api" + path, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
    return r.json();
  }

  function roleOf(a) {
    if (a.depth === 0) return "Manager";
    if (/reviewer/.test(a.route || "")) return "Reviewer";
    if (a.has_children || a.role === "orchestrator") return a.route === "lead-deep" ? "Leader · Opus" : "Leader";
    if (a.depth === 1) return /planner|lead-deep/.test(a.route || "") ? "Planner" : "Agent";
    return "Worker";
  }

  function statusPill(s, tracked) {
    const label = tracked === false && s === "done" ? "done · untracked" : s;
    return `<span class="pill ${esc(s)}">${s === "running" ? "● " : ""}${esc(label)}</span>`;
  }

  // ---------- top bar ----------
  async function renderTop() {
    try {
      const s = await api("/summary");
      const sp = s.spend || {};
      const lag = s.collector ? s.collector.lag_s : null;
      const healthy = lag != null && lag < 60 && !s.collector.last_error;
      document.getElementById("top-stats").innerHTML = [
        `<span><span class="dot ${healthy ? "ok" : "bad"}"></span>collector ${lag != null ? dur(lag) + " ago" : "offline"}</span>`,
        `<span>today <b>${usd(sp.usage_daily)}</b></span>`,
        `<span>month <b>${usd(sp.usage_monthly)}</b></span>`,
        `<span>key left <b>${usd(sp.limit_remaining)}</b></span>`,
        sp.free_requests ? `<span>free req <b>${sp.free_requests.used}/${sp.free_requests.limit}</b></span>` : "",
      ].join("");
      document.getElementById("foot").textContent = sp.expires_at ? `OpenRouter key expires ${new Date(sp.expires_at).toLocaleDateString()}. Data refreshes every 5 s.` : "";
      return s;
    } catch (e) {
      document.getElementById("top-stats").innerHTML = `<span><span class="dot bad"></span>${esc(e.message)}</span>`;
      return null;
    }
  }

  // ---------- stage stepper ----------
  function stepper(task) {
    const reached = new Map((task.stages || []).map((s) => [s.stage, s.ts]));
    const failed = task.status === "failed" || task.status === "cancelled";
    const curIdx = task.status === "done" ? STAGES.length - 1 : STAGES.indexOf(task.stage);
    return `<ol class="stepper">${STAGES.map((st, i) => {
      let cls = "";
      if (task.tracked === false) cls = task.status === "done" ? "done" : "";
      else if (st === "done" && task.status === "done") cls = "done";
      else if (i < curIdx || (reached.has(st) && i !== curIdx)) cls = "done";
      else if (i === curIdx) cls = failed ? "failed" : "current";
      const t = st === "done" ? task.ended_at : reached.get(st);
      return `<li class="${cls}"><span class="n">${esc(STAGE_LABEL[st])}</span><span class="t">${t ? clock(t) : "&nbsp;"}</span></li>`;
    }).join("")}</ol>`;
  }

  function budgetBar(task) {
    const spent = task.cost_usd ?? task.cost_live_usd ?? task.subagent_cost_usd ?? 0;
    const pct = Math.min(100, (spent / BUDGET) * 100);
    const est = task.estimate_usd ? Math.min(100, (task.estimate_usd / BUDGET) * 100) : null;
    return `<div class="budget">
      <div class="legend"><span>spent <b class="mono">${usd(spent)}</b></span><span>estimate <b class="mono">${usd(task.estimate_usd)}</b></span><span>budget <b class="mono">${usd(BUDGET)}</b></span></div>
      <div class="bar" role="img" aria-label="Spent ${usd(spent)} of ${usd(BUDGET)} budget"><span class="spent" style="width:${pct}%"></span>${est != null ? `<span class="est" style="width:${est}%"></span>` : ""}</div>
    </div>`;
  }

  // ---------- flow graph ----------
  function flowGraph(task, agents, root) {
    const nodes = new Map();
    const rootId = task.root_id || "root";
    nodes.set(rootId, { _id: rootId, depth: 0, model: root?.model || "", tier: root?.tier || "cheap", title: "Telegram conversation", status: task.status === "running" ? "running" : "done", children: [] });
    for (const a of agents) nodes.set(a._id, { ...a, children: [] });
    for (const a of agents) {
      const p = nodes.get(a.parent_id) || nodes.get(rootId);
      p.children.push(nodes.get(a._id));
    }
    const W = 232, H = 62, GX = 70, GY = 14, PAD = 8;
    let slot = 0;
    const place = (n) => {
      n.children.sort((a, b) => (a.started_at || 0) - (b.started_at || 0));
      if (!n.children.length) { n.y = slot++ * (H + GY); }
      else { n.children.forEach(place); n.y = (n.children[0].y + n.children[n.children.length - 1].y) / 2; }
    };
    const top = nodes.get(rootId);
    place(top);
    const maxDepth = Math.max(0, ...agents.map((a) => a.depth || 0));
    const width = PAD * 2 + (maxDepth + 1) * W + maxDepth * GX;
    const height = PAD * 2 + Math.max(1, slot) * (H + GY) - GY;
    const x = (d) => PAD + d * (W + GX);
    let edges = "", boxes = "";
    const visit = (n) => {
      for (const c of n.children) {
        const x1 = x(n.depth) + W, y1 = PAD + n.y + H / 2, x2 = x(c.depth), y2 = PAD + c.y + H / 2, mx = (x1 + x2) / 2;
        edges += `<path class="edge" d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}"/>`;
        visit(c);
      }
      const nx = x(n.depth), ny = PAD + n.y;
      const role = n.depth === 0 ? "Manager" : roleOf(n);
      const title = (n.title || n.goal || "").slice(0, 34);
      const time = n.depth === 0 ? "" : " · " + dur((n.ended_at || nowS()) - (n.started_at || nowS()));
      const meta = `${shortModel(n.model).slice(0, 22)}${n.depth === 0 ? "" : " · " + usd(n.cost_usd || 0)}${time}`;
      boxes += `<g class="node ${esc(n.status)}" data-agent="${esc(n._id)}" tabindex="0" role="button" aria-label="${esc(role + ": " + (n.title || ""))}">
        <title>${esc((n.goal || n.title || "") + "\n" + (n.model || ""))}</title>
        <rect class="box" x="${nx}" y="${ny}" width="${W}" height="${H}" rx="8"/>
        <rect x="${nx}" y="${ny}" width="5" height="${H}" rx="2" fill="${tierVar(n.tier)}"/>
        <text class="role" x="${nx + 14}" y="${ny + 18}">${esc(role)}${n.route ? " · " + esc(n.route) : ""}</text>
        <text x="${nx + 14}" y="${ny + 36}">${esc(title)}</text>
        <text class="meta" x="${nx + 14}" y="${ny + 53}">${esc(meta)}</text>
        ${n.status === "running" ? `<circle class="pulse" cx="${nx + W - 14}" cy="${ny + 14}" r="5"/>` : ""}
      </g>`;
    };
    visit(top);
    return `<div class="graph"><svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Agent team flow graph">${edges}${boxes}</svg></div>`;
  }

  function tierStack(rows, total) {
    if (!total) return `<div class="stack"></div>`;
    return `<div class="stack" role="img" aria-label="Cost by model tier">${rows.map((r) => `<span style="width:${(100 * r.cost_usd) / total}%;background:${tierVar(r._id || r.tier)}" title="${esc((r._id || r.model) + " " + usd(r.cost_usd))}"></span>`).join("")}</div>`;
  }

  // ---------- overview ----------
  async function renderOverview() {
    const [summary, tasks, live] = await Promise.all([renderTop(), api("/tasks?limit=100"), api("/live")]);
    const t = summary?.tasks || {};
    const tiers = (summary?.agents_by_tier || []).sort((a, b) => ["free", "cheap", "sonnet", "opus"].indexOf(a._id) - ["free", "cheap", "sonnet", "opus"].indexOf(b._id));
    const tierTotal = tiers.reduce((s, r) => s + r.cost_usd, 0);
    let liveHtml = `<section class="panel"><div class="panel-head"><h2>Now</h2><span class="pill session">idle</span></div><p class="muted">No task is running. Send a build request to @anuj870_hermes2_bot and it will appear here live.</p></section>`;
    if (live.task) {
      const lt = live.task;
      const det = await api("/tasks/" + encodeURIComponent(lt._id));
      liveHtml = `<section class="panel live">
        <div class="panel-head"><div><span class="eyebrow">Live task</span><h2><a href="#task-${encodeURIComponent(lt._id)}">${esc(lt.title)}</a></h2></div>
          <div class="controls">${statusPill(lt.status)}<span class="muted">${esc(STAGE_LABEL[lt.stage] || lt.stage)} · ${dur(nowS() - lt.started_at)}</span></div></div>
        ${stepper(lt)}
        ${budgetBar(lt)}
        <div class="legend"><span>teams <b class="mono">${lt.leaders ?? 0}${lt.planned_teams ? "/" + lt.planned_teams : ""}</b></span><span>workers <b class="mono">${lt.workers ?? 0}${lt.planned_workers ? "/" + lt.planned_workers : ""}</b></span><span>reviewers <b class="mono">${lt.reviewers ?? 0}</b></span><span>running now <b class="mono">${lt.running_agents ?? 0}</b></span></div>
        ${flowGraph(det.task, det.agents, det.root)}
      </section>`;
    }
    view.innerHTML = `
      ${liveHtml}
      <section class="panel">
        <div class="panel-head"><h2>Totals</h2><span class="muted">all tracked and reconstructed tasks</span></div>
        <div class="grid-kpi">
          <div class="kpi"><span class="v">${t.done ?? 0}<span class="muted" style="font-size:14px"> / ${t.total ?? 0}</span></span><span class="l">tasks done / total</span></div>
          <div class="kpi"><span class="v">${usd(t.avg_cost_usd)}</span><span class="l">average cost per finished task</span></div>
          <div class="kpi"><span class="v">${dur(t.avg_duration_s)}</span><span class="l">average duration</span></div>
          <div class="kpi"><span class="v">${usd(summary?.manager_sessions?.cost_usd)}</span><span class="l">Manager chat (all sessions)</span></div>
        </div>
        <div class="budget"><span class="eyebrow">Sub-agent spend by model tier</span>${tierStack(tiers, tierTotal)}
          <div class="legend">${tiers.map((r) => `<span><i style="background:${tierVar(r._id)}"></i>${esc(r._id)} ${usd(r.cost_usd)} · ${r.agents} agents · ${r.api_calls} calls</span>`).join("")}</div></div>
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Tasks</h2><span class="muted">${tasks.length} shown, newest first</span></div>
        ${tasks.length ? `<div class="scroll"><table>
          <thead><tr><th>Task</th><th>Status</th><th>Stage</th><th>Teams / workers</th><th class="num">Cost</th><th class="num">Duration</th><th>Started</th></tr></thead>
          <tbody>${tasks.map((x) => `<tr class="click" data-task="${esc(x._id)}" tabindex="0">
            <td><a href="#task-${encodeURIComponent(x._id)}">${esc(x.title)}</a>${x.url ? `<span class="sub">${esc(x.url)}</span>` : x.repo ? `<span class="sub">${esc(x.repo)}</span>` : ""}</td>
            <td>${statusPill(x.status, x.tracked)}</td>
            <td>${esc(STAGE_LABEL[x.stage] || x.stage || "–")}</td>
            <td class="mono">${x.leaders ?? 0} / ${x.workers ?? 0}${x.reviewers ? ` +${x.reviewers}r` : ""}</td>
            <td class="num mono">${usd(x.cost_usd ?? x.cost_live_usd ?? x.subagent_cost_usd)}</td>
            <td class="num mono">${dur((x.ended_at || nowS()) - x.started_at)}</td>
            <td class="mono">${when(x.started_at)}</td></tr>`).join("")}</tbody></table></div>` : `<p class="empty">No tasks yet.</p>`}
      </section>`;
    view.querySelectorAll("tr[data-task]").forEach((tr) => {
      const go = () => { location.hash = "task-" + encodeURIComponent(tr.dataset.task); };
      tr.addEventListener("click", (e) => { if (e.target.tagName !== "A") go(); });
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
    });
    bindGraph();
    schedule(renderOverview, 5000);
  }

  // ---------- task detail ----------
  async function renderTask(id, keepScroll) {
    const [, det] = await Promise.all([renderTop(), api("/tasks/" + encodeURIComponent(id))]);
    const { task, agents, root } = det;
    if (logState.taskId !== id) logState = { taskId: id, since: 0, agent: "", lines: [] };
    const q = `?since=${logState.since}${logState.agent ? "&agent=" + encodeURIComponent(logState.agent) : ""}`;
    const fresh = await api(`/tasks/${encodeURIComponent(id)}/logs${q}`);
    logState.lines = logState.lines.concat(fresh).slice(-2000);
    if (fresh.length) logState.since = fresh[fresh.length - 1].ts;
    const names = new Map(agents.map((a) => [a._id, `${roleOf(a)}${a.route ? " · " + a.route : ""}`]));
    if (task.root_id) names.set(task.root_id, "Manager");
    const models = task.cost_by_model || [];
    const modelTotal = models.reduce((s, m) => s + m.cost_usd, 0);
    const logsEl = document.getElementById("logbox");
    const atBottom = !logsEl || logsEl.scrollTop + logsEl.clientHeight >= logsEl.scrollHeight - 30;
    const prevScroll = window.scrollY;
    view.innerHTML = `
      <a class="back" href="#">← All tasks</a>
      <section class="panel ${task.status === "running" ? "live" : ""}">
        <div class="panel-head"><div><span class="eyebrow">${esc(task._id)}</span><h1>${esc(task.title)}</h1></div>
          <div class="controls">${statusPill(task.status, task.tracked)}<span class="muted">${when(task.started_at)} · ${dur((task.ended_at || nowS()) - task.started_at)}</span></div></div>
        <div class="links">${task.repo ? `<a href="${esc(task.repo)}" target="_blank" rel="noopener">Repository ↗</a>` : ""}${task.url ? `<a href="${esc(task.url)}" target="_blank" rel="noopener">Live app ↗</a>` : ""}</div>
        ${task.end_note ? `<p class="muted">${esc(task.end_note)}</p>` : ""}
        ${stepper(task)}
        ${budgetBar(task)}
      </section>
      <section class="panel">
        <div class="panel-head"><h2>Team flow</h2>
          <div class="legend"><span>leaders <b class="mono">${task.leaders ?? 0}</b></span><span>workers <b class="mono">${task.workers ?? 0}</b></span><span>reviewers <b class="mono">${task.reviewers ?? 0}</b></span><span>running <b class="mono">${task.running_agents ?? 0}</b></span>
          ${Object.keys(TIER_VAR).map((k) => `<span><i style="background:${tierVar(k)}"></i>${k}</span>`).join("")}</div></div>
        ${agents.length ? flowGraph(task, agents, root) : `<p class="empty">No sub-agents yet.</p>`}
        <p class="muted" style="font-size:12px">Click a node to filter the logs to that agent.</p>
      </section>
      <div class="two">
        <section class="panel">
          <div class="panel-head"><h2>Agents</h2></div>
          <div class="scroll"><table><thead><tr><th>Agent</th><th>Model</th><th>Status</th><th class="num">Cost</th><th class="num">Calls</th><th class="num">Time</th></tr></thead>
          <tbody>${agents.map((a) => `<tr class="click" data-agent="${esc(a._id)}" tabindex="0"><td>${esc(roleOf(a))}${a.route ? ` <span class="mono muted">${esc(a.route)}</span>` : ""}<span class="sub">${esc((a.title || "").slice(0, 70))}</span></td>
            <td><span class="tier ${esc(a.tier)}">${esc(a.tier)}</span> <span class="mono">${esc(shortModel(a.model))}</span></td><td>${statusPill(a.status)}</td>
            <td class="num mono">${usd(a.cost_usd || 0)}</td><td class="num mono">${a.api_call_count ?? "–"}</td><td class="num mono">${dur((a.ended_at || nowS()) - a.started_at)}</td></tr>`).join("")}</tbody></table></div>
        </section>
        <section class="panel">
          <div class="panel-head"><h2>Cost by model</h2><span class="mono">${usd(modelTotal)}</span></div>
          ${tierStack(models, modelTotal)}
          <div class="scroll"><table><tbody>${models.map((m) => `<tr><td><span class="tier ${esc(m.tier)}">${esc(m.tier)}</span> <span class="mono">${esc(shortModel(m.model))}</span><span class="sub">${m.agents} agents · ${m.api_calls} calls</span></td><td class="num mono">${usd(m.cost_usd)}</td></tr>`).join("") || `<tr><td class="muted">no data</td></tr>`}</tbody></table></div>
          <p class="muted" style="font-size:12px">Sub-agents only. The Manager's share is included in the task total when tracking recorded start and end spend.</p>
        </section>
      </div>
      <section class="panel">
        <div class="panel-head"><h2>Logs</h2>
          <div class="controls"><label class="muted" for="agentFilter">Agent</label>
            <select id="agentFilter"><option value="">All agents</option>${[...names].map(([k, v]) => `<option value="${esc(k)}" ${k === logState.agent ? "selected" : ""}>${esc(v)} · ${esc(k.slice(-6))}</option>`).join("")}</select>
            <span class="muted mono">${logState.lines.length} lines</span></div></div>
        <div class="logs" id="logbox">${logState.lines.map((l) => `<div class="log k-${esc(l.kind)}"><span class="ts">${clock(l.ts)}</span><span class="who">${esc(names.get(l.session_id) || l.session_id.slice(-6))}</span><span class="msg">${l.tool && l.kind === "tool_result" ? esc(l.tool) + " → " : ""}${esc(l.text)}</span></div>`).join("") || `<p class="empty">No log lines yet.</p>`}</div>
      </section>`;
    if (keepScroll) window.scrollTo(0, prevScroll);
    const box = document.getElementById("logbox");
    if (box && atBottom) box.scrollTop = box.scrollHeight;
    document.getElementById("agentFilter").addEventListener("change", (e) => { logState = { taskId: id, since: 0, agent: e.target.value, lines: [] }; renderTask(id, true); });
    view.querySelectorAll("tr[data-agent]").forEach((tr) => tr.addEventListener("click", () => filterAgent(id, tr.dataset.agent)));
    bindGraph(id);
    schedule(() => renderTask(id, true), task.status === "running" ? 4000 : 30000);
  }

  function filterAgent(taskId, agentId) {
    logState = { taskId, since: 0, agent: agentId, lines: [] };
    renderTask(taskId, true).then(() => document.getElementById("logbox")?.scrollIntoView({ behavior: "smooth", block: "start" }));
  }

  function bindGraph(taskId) {
    view.querySelectorAll(".graph .node").forEach((g) => {
      const act = () => { if (taskId) filterAgent(taskId, g.dataset.agent); else { const a = g.closest(".panel")?.querySelector("h2 a"); if (a) location.hash = a.getAttribute("href").slice(1); } };
      g.addEventListener("click", act);
      g.addEventListener("keydown", (e) => { if (e.key === "Enter") act(); });
    });
  }

  function schedule(fn, ms) {
    clearTimeout(timer);
    timer = setTimeout(() => { if (!document.hidden) fn().catch(showError); else schedule(fn, ms); }, ms);
  }
  function showError(e) { view.innerHTML = `<section class="panel"><h2>Can't load data</h2><p class="muted">${esc(e.message)}. Retrying…</p></section>`; schedule(route, 8000); }

  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    clearTimeout(timer);
    return (h.startsWith("task-") ? renderTask(h.slice(5)) : renderOverview()).catch(showError);
  }
  window.addEventListener("hashchange", () => { window.scrollTo(0, 0); route(); });
  route();
})();
