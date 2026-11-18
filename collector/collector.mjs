// Mission Control collector: syncs Hermes #2 state (sessions, tool calls, stage events) into MongoDB.
// Runs as a sidecar next to Hermes with the Hermes data volume mounted at HERMES_DIR (default /hermes).
import { DatabaseSync } from "node:sqlite";
import { createRequire } from "node:module";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";

const HERMES = process.env.HERMES_DIR || "/hermes";
const requireFrom = createRequire(process.env.MODULES_FROM || `${HERMES}/tools/package.json`);
const { MongoClient } = requireFrom("mongodb");

const INTERVAL_MS = Number(process.env.INTERVAL_MS || 5000);
const LEGACY_GAP_S = 8 * 60;

function readEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^'(.*)'$/, "$1");
  }
  return out;
}
const collectorEnv = { ...readEnvFile(`${HERMES}/devteam/collector.env`), ...process.env };
const hermesEnv = readEnvFile(`${HERMES}/.env`);
const MONGO_URI = collectorEnv.MONGO_URI;
if (!MONGO_URI) { console.error("MONGO_URI missing (devteam/collector.env)"); process.exit(1); }

const SECRET_PATTERNS = [
  [/sk-or-v1-[A-Za-z0-9]+/g, "sk-or-v1-***"],
  [/github_pat_[A-Za-z0-9_]+/g, "github_pat_***"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "gh*_***"],
  [/\b\d+\|[A-Za-z0-9]{30,}/g, "<coolify-token>"],
  [/\b\d{8,10}:[A-Za-z0-9_-]{30,}/g, "<telegram-token>"],
  [/((?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^:\s/]+:)[^@\s]+@/g, "$1***@"],
  [/(password["'\s:=]+)[^\s"',}]{6,}/gi, "$1***"],
];
const redact = (s) => { let t = String(s ?? ""); for (const [re, rep] of SECRET_PATTERNS) t = t.replace(re, rep); return t; };
const clip = (s, n = 400) => { const t = redact(s).replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
const safeJson = (s) => { try { return JSON.parse(s); } catch { return null; } };

function modelTier(model = "") {
  if (model.endsWith(":free")) return "free";
  if (model.includes("opus")) return "opus";
  if (model.includes("sonnet")) return "sonnet";
  return "cheap";
}

function summarizeToolCall(name, args) {
  const a = args || {};
  switch (name) {
    case "terminal": return `$ ${clip(a.command || a.cmd || "", 300)}`;
    case "write_file": return `write ${a.path || a.file_path || ""}`;
    case "read_file": return `read ${a.path || a.file_path || ""}`;
    case "patch": return `patch ${a.path || a.file_path || ""}`;
    case "search_files": return `search ${clip(a.pattern || a.query || "", 120)}`;
    case "clarify": return `ask owner: ${clip(a.question || a.prompt || JSON.stringify(a), 300)}`;
    case "send_message": return `message: ${clip(a.message || a.text || a.content || "", 300)}`;
    case "skill_view": return `skill ${a.name || a.skill || ""}`;
    case "delegate_task": {
      const tasks = Array.isArray(a.tasks) ? a.tasks : [a];
      const parts = tasks.map((t) => `${t.option || "default"}/${t.role || "leaf"}`);
      return `delegate ${tasks.length} task(s): ${parts.join(", ")}`;
    }
    default: return `${name} ${clip(JSON.stringify(a), 200)}`;
  }
}

async function openRouterUsage() {
  const key = hermesEnv.OPENROUTER_API_KEY;
  if (!key) return null;
  try {
    const r = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) });
    const d = (await r.json()).data;
    return { usage: d.usage, usage_daily: d.usage_daily, usage_monthly: d.usage_monthly, limit: d.limit, limit_remaining: d.limit_remaining,
             free_requests: d.free_model_daily_requests, expires_at: d.expires_at, ts: Date.now() / 1000 };
  } catch { return null; }
}

const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 5000 });
await client.connect();
const db = client.db();
const C = {
  agents: db.collection("agents"),
  logs: db.collection("logs"),
  delegations: db.collection("delegations"),
  tasks: db.collection("tasks"),
  state: db.collection("state"),
};
await C.logs.createIndex({ session_id: 1, ts: 1 });
await C.logs.createIndex({ task_id: 1, ts: 1 });
await C.logs.createIndex({ msg_id: 1, n: 1 }, { unique: true });
await C.agents.createIndex({ task_id: 1 });
await C.agents.createIndex({ root_id: 1, started_at: 1 });
await C.delegations.createIndex({ parent_session: 1, ts: 1 });
await C.tasks.createIndex({ started_at: -1 });

async function getState() {
  const s = (await C.state.findOne({ _id: "collector" })) || {};
  return { _id: "collector", ...s, last_msg_id: s.last_msg_id ?? 0, events_offset: s.events_offset ?? 0, last_usage_poll: s.last_usage_poll ?? 0 };
}

let sessionsCache = new Map();

function syncSessionsFrom(sqlite) {
  const rows = sqlite.prepare(`select id, parent_session_id, source, model, title, started_at, ended_at, end_reason, message_count,
      tool_call_count, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens, estimated_cost_usd, api_call_count,
      last_activity_at, last_activity_description from sessions`).all();
  const map = new Map(rows.map((r) => [r.id, r]));
  const depthOf = (r) => { let d = 0, cur = r, guard = 0; while (cur?.parent_session_id && guard++ < 10) { d++; cur = map.get(cur.parent_session_id); } return d; };
  const rootOf = (r) => { let cur = r, guard = 0; while (cur?.parent_session_id && map.get(cur.parent_session_id) && guard++ < 10) cur = map.get(cur.parent_session_id); return cur.id; };
  sessionsCache = map;
  return rows.map((r) => ({ ...r, depth: depthOf(r), root_id: rootOf(r) }));
}

async function upsertAgents(rows) {
  const parents = new Set(rows.filter((r) => r.depth >= 2).map((r) => r.parent_session_id));
  const ops = rows.map((r) => ({
    updateOne: {
      filter: { _id: r.id },
      update: {
        $set: {
          parent_id: r.parent_session_id, root_id: r.root_id, depth: r.depth, source: r.source, model: r.model, tier: modelTier(r.model || ""),
          title: clip((r.title || "").replace(/^Subagent:\s*/, ""), 200), started_at: r.started_at, ended_at: r.ended_at, end_reason: r.end_reason,
          status: r.depth === 0 ? "session" : r.ended_at ? (r.end_reason && /error|fail|cancel|interrupt/i.test(r.end_reason) ? "failed" : "done") : "running",
          message_count: r.message_count, tool_call_count: r.tool_call_count, api_call_count: r.api_call_count,
          input_tokens: r.input_tokens, output_tokens: r.output_tokens, cache_read_tokens: r.cache_read_tokens, reasoning_tokens: r.reasoning_tokens,
          cost_usd: r.estimated_cost_usd || 0, last_activity_at: r.last_activity_at, last_activity: clip(r.last_activity_description || "", 200),
          has_children: parents.has(r.id),
        },
      },
      upsert: true,
    },
  }));
  if (ops.length) await C.agents.bulkWrite(ops, { ordered: false });
}

async function syncMessages(sqlite, state) {
  const msgs = sqlite.prepare(`select id, session_id, role, content, tool_calls, tool_name, timestamp from messages where id > ? order by id limit 3000`).all(state.last_msg_id);
  if (!msgs.length) return state.last_msg_id;
  const logs = [], delegs = [], firstUser = [];
  for (const m of msgs) {
    const base = { session_id: m.session_id, ts: m.timestamp, msg_id: m.id };
    if (m.role === "assistant") {
      const calls = safeJson(m.tool_calls) || [];
      if (m.content && String(m.content).trim()) logs.push({ ...base, n: 0, kind: "say", text: clip(m.content, 500) });
      calls.forEach((c, i) => {
        const name = c.function?.name || c.name || "tool";
        const args = safeJson(c.function?.arguments) || {};
        logs.push({ ...base, n: i + 1, kind: "tool", tool: name, text: summarizeToolCall(name, args) });
        if (name === "delegate_task") {
          const tasks = Array.isArray(args.tasks) ? args.tasks : [args];
          tasks.forEach((t, j) => delegs.push({ _id: `${m.id}-${i}-${j}`, parent_session: m.session_id, ts: m.timestamp,
            goal: clip(t.goal || "", 600), goal_key: String(t.goal || "").replace(/\s+/g, " ").trim().slice(0, 80),
            role: t.role || args.role || "leaf", option: t.option || args.option || null }));
        }
      });
    } else if (m.role === "tool") {
      const txt = String(m.content || "");
      const isErr = /"(error|exit_code)":\s*("[^"]+"|[1-9]\d*)|Traceback|ERROR|failed/i.test(txt.slice(0, 600));
      logs.push({ ...base, n: 0, kind: isErr ? "tool_error" : "tool_result", tool: m.tool_name, text: clip(txt, 300) });
    } else if (m.role === "user") {
      logs.push({ ...base, n: 0, kind: "user", text: clip(m.content, 400) });
      firstUser.push({ session_id: m.session_id, text: String(m.content || "").replace(/\s+/g, " ").trim().slice(0, 80) });
    }
  }
  if (logs.length) await C.logs.bulkWrite(logs.map((l) => ({ updateOne: { filter: { msg_id: l.msg_id, n: l.n }, update: { $setOnInsert: l }, upsert: true } })), { ordered: false });
  if (delegs.length) await C.delegations.bulkWrite(delegs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $setOnInsert: d }, upsert: true } })), { ordered: false });
  for (const f of firstUser) await C.agents.updateOne({ _id: f.session_id, first_user: { $exists: false } }, { $set: { first_user: f.text } });
  return msgs[msgs.length - 1].id;
}

async function matchRoutes() {
  const pending = await C.agents.find({ depth: { $gte: 1 }, route: { $exists: false }, first_user: { $exists: true } }).limit(200).toArray();
  for (const a of pending) {
    const d = await C.delegations.findOne({ parent_session: a.parent_id, goal_key: a.first_user });
    const fallback = d || (await C.delegations.findOne({ parent_session: a.parent_id, goal_key: { $regex: "^" + a.first_user.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") } }));
    if (fallback) await C.agents.updateOne({ _id: a._id }, { $set: { route: fallback.option || "default", role: fallback.role, goal: fallback.goal } });
  }
}

function readNewEvents(state) {
  const path = `${HERMES}/devteam/events.jsonl`;
  if (!existsSync(path)) return { events: [], offset: state.events_offset };
  const size = statSync(path).size;
  let offset = state.events_offset > size ? 0 : state.events_offset;
  if (size === offset) return { events: [], offset };
  const fd = openSync(path, "r");
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  const text = buf.toString("utf8");
  const lastNl = text.lastIndexOf("\n");
  if (lastNl < 0) return { events: [], offset };
  const events = text.slice(0, lastNl).split("\n").filter(Boolean).map(safeJson).filter(Boolean);
  return { events, offset: offset + Buffer.byteLength(text.slice(0, lastNl + 1)) };
}

function currentTelegramRoot() {
  let best = null;
  for (const r of sessionsCache.values()) if (!r.parent_session_id && r.source === "telegram" && (!best || (r.last_activity_at || 0) > (best.last_activity_at || 0))) best = r;
  return best?.id || null;
}

async function applyEvents(events) {
  for (const e of events) {
    if (!e.task_id || String(e.task_id).startsWith("selftest-")) continue;
    if (e.type === "task_start") {
      await C.tasks.updateOne({ _id: e.task_id }, { $setOnInsert: { slug: e.slug, title: clip(e.title, 200), status: "running", stage: "intake",
        started_at: e.ts, spend_start: e.spend_usd, root_id: currentTelegramRoot(), stages: [], tracked: true } }, { upsert: true });
    } else if (e.type === "stage") {
      const set = { stage: e.stage };
      if (e.estimate_usd != null) set.estimate_usd = e.estimate_usd;
      if (e.teams != null) set.planned_teams = e.teams;
      if (e.workers != null) set.planned_workers = e.workers;
      await C.tasks.updateOne({ _id: e.task_id }, { $set: set, $push: { stages: { stage: e.stage, ts: e.ts, note: clip(e.note || "", 300), spend: e.spend_usd } } });
    } else if (e.type === "link") {
      const set = {}; if (e.repo) set.repo = e.repo; if (e.url) set.url = e.url;
      if (Object.keys(set).length) await C.tasks.updateOne({ _id: e.task_id }, { $set: set });
    } else if (e.type === "task_end") {
      const t = await C.tasks.findOne({ _id: e.task_id });
      const cost = t && t.spend_start != null && e.spend_usd != null ? Math.max(0, e.spend_usd - t.spend_start) : null;
      await C.tasks.updateOne({ _id: e.task_id }, { $set: { status: e.status, ended_at: e.ts, spend_end: e.spend_usd, cost_usd: cost, end_note: clip(e.note || "", 300), stage: e.status } });
    }
  }
}

async function assignAgentsToTasks(usage) {
  const tasks = await C.tasks.find({ tracked: true, $or: [{ status: "running" }, { ended_at: { $gt: Date.now() / 1000 - 3600 } }] }).toArray();
  for (const t of tasks) {
    const until = t.ended_at || Date.now() / 1000 + 60;
    await C.agents.updateMany({ root_id: t.root_id, depth: { $gte: 1 }, started_at: { $gte: t.started_at - 5, $lte: until } }, { $set: { task_id: t._id } });
    const set = await taskAggregates(t._id);
    if (t.status === "running" && usage && t.spend_start != null) set.cost_live_usd = Math.max(0, usage.usage - t.spend_start);
    await C.tasks.updateOne({ _id: t._id }, { $set: set });
  }
}

async function taskAggregates(taskId) {
  const agents = await C.agents.find({ task_id: taskId }).toArray();
  const byModel = {};
  for (const a of agents) {
    const k = a.model || "?";
    byModel[k] ??= { model: k, tier: a.tier, agents: 0, cost_usd: 0, api_calls: 0 };
    byModel[k].agents++; byModel[k].cost_usd += a.cost_usd || 0; byModel[k].api_calls += a.api_call_count || 0;
  }
  return {
    agents_total: agents.length,
    leaders: agents.filter((a) => a.depth === 1 && (a.has_children || a.role === "orchestrator")).length,
    planners: agents.filter((a) => a.depth === 1 && !a.has_children && a.role !== "orchestrator" && /planner|lead-deep/.test(a.route || "")).length,
    workers: agents.filter((a) => a.depth >= 2 && !/reviewer/.test(a.route || "")).length,
    reviewers: agents.filter((a) => /reviewer/.test(a.route || "")).length,
    running_agents: agents.filter((a) => a.status === "running").length,
    subagent_cost_usd: agents.reduce((s, a) => s + (a.cost_usd || 0), 0),
    cost_by_model: Object.values(byModel).sort((a, b) => b.cost_usd - a.cost_usd),
  };
}

async function inferLegacyTasks() {
  const firstTracked = await C.tasks.find({ tracked: true }).sort({ started_at: 1 }).limit(1).next();
  const cutoff = firstTracked ? firstTracked.started_at - 5 : Date.now() / 1000 - 600;
  const tops = await C.agents.find({ depth: 1, task_id: { $exists: false }, started_at: { $lt: cutoff } }).sort({ started_at: 1 }).toArray();
  let group = [], last = null;
  const flush = async () => {
    if (!group.length) return;
    const id = `legacy-${group[0]._id}`;
    const ids = group.map((g) => g._id);
    await C.agents.updateMany({ $or: [{ _id: { $in: ids } }, { parent_id: { $in: ids } }] }, { $set: { task_id: id } });
    const agg = await taskAggregates(id);
    const allAgents = await C.agents.find({ task_id: id }).toArray();
    const ended = Math.max(...allAgents.map((a) => a.ended_at || a.last_activity_at || a.started_at));
    const ask = await C.logs.find({ session_id: group[0].root_id, kind: "user", ts: { $lt: group[0].started_at } }).sort({ ts: -1 }).limit(1).next();
    const title = ask ? clip(ask.text.replace(/^(hello|hi|hey)[,!.\s]*/i, ""), 120) : group[0].title || "Untracked run";
    await C.tasks.updateOne({ _id: id }, { $set: { title, slug: null, status: "done", stage: "done", tracked: false,
      started_at: group[0].started_at, ended_at: ended, root_id: group[0].root_id, cost_usd: agg.subagent_cost_usd, ...agg,
      end_note: "Ran before Mission Control tracking; stages unknown, agent tree reconstructed from Hermes sessions." } }, { upsert: true });
    group = [];
  };
  for (const a of tops) {
    if (last && a.started_at - last > LEGACY_GAP_S) await flush();
    group.push(a); last = a.ended_at || a.started_at;
  }
  await flush();
}

async function cycle() {
  const t0 = Date.now();
  const state = await getState();
  const sqlite = new DatabaseSync(`${HERMES}/state.db`, { readOnly: true });
  try {
    const rows = syncSessionsFrom(sqlite);
    await upsertAgents(rows);
    state.last_msg_id = await syncMessages(sqlite, state);
  } finally { sqlite.close(); }
  await matchRoutes();
  const { events, offset } = readNewEvents(state);
  await applyEvents(events);
  state.events_offset = offset;
  let usage = null;
  if (Date.now() / 1000 - (state.last_usage_poll || 0) > 20) {
    usage = await openRouterUsage();
    if (usage) { state.last_usage_poll = usage.ts; await C.state.updateOne({ _id: "openrouter" }, { $set: usage }, { upsert: true }); }
  } else {
    usage = await C.state.findOne({ _id: "openrouter" });
  }
  await assignAgentsToTasks(usage);
  await inferLegacyTasks();
  const tasked = await C.agents.find({ task_id: { $exists: true }, logs_tagged: { $ne: true } }).project({ task_id: 1, status: 1 }).toArray();
  for (const a of tasked) {
    await C.logs.updateMany({ session_id: a._id, task_id: { $exists: false } }, { $set: { task_id: a.task_id } });
    if (a.status !== "running") await C.agents.updateOne({ _id: a._id }, { $set: { logs_tagged: true } });
  }
  await C.state.updateOne({ _id: "collector" }, { $set: { last_msg_id: state.last_msg_id, events_offset: state.events_offset,
    last_usage_poll: state.last_usage_poll, last_cycle_at: Date.now() / 1000, last_cycle_ms: Date.now() - t0, last_error: null } }, { upsert: true });
}

let stopping = false;
process.on("SIGTERM", () => { stopping = true; });
console.log(`collector started: hermes=${HERMES} interval=${INTERVAL_MS}ms`);
while (!stopping) {
  try { await cycle(); }
  catch (e) {
    console.error("cycle error:", e.message);
    await C.state.updateOne({ _id: "collector" }, { $set: { last_error: clip(e.message, 300), last_error_at: Date.now() / 1000 } }, { upsert: true }).catch(() => {});
  }
  if (process.env.ONCE) break;
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
await client.close();
