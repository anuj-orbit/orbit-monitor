import { Router } from "express";

const now = () => Date.now() / 1000;

export function apiRouter(getDb) {
  const r = Router();
  const col = (n) => getDb().collection(n);

  r.get("/summary", async (_req, res) => {
    const [tasks, openrouter, collector, byTier, chat] = await Promise.all([
      col("tasks").find({}, { projection: { status: 1, cost_usd: 1, cost_live_usd: 1, started_at: 1, ended_at: 1, tracked: 1 } }).toArray(),
      col("state").findOne({ _id: "openrouter" }),
      col("state").findOne({ _id: "collector" }),
      col("agents").aggregate([
        { $match: { depth: { $gte: 1 } } },
        { $group: { _id: "$tier", agents: { $sum: 1 }, cost_usd: { $sum: "$cost_usd" }, api_calls: { $sum: "$api_call_count" } } },
      ]).toArray(),
      col("agents").aggregate([
        { $match: { depth: 0 } },
        { $group: { _id: null, sessions: { $sum: 1 }, cost_usd: { $sum: "$cost_usd" } } },
      ]).toArray(),
    ]);
    const done = tasks.filter((t) => t.status === "done");
    const costs = done.map((t) => t.cost_usd).filter((c) => typeof c === "number");
    res.json({
      tasks: {
        total: tasks.length,
        running: tasks.filter((t) => t.status === "running").length,
        done: done.length,
        failed: tasks.filter((t) => t.status === "failed").length,
        cancelled: tasks.filter((t) => t.status === "cancelled").length,
        avg_cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) / costs.length : null,
        avg_duration_s: done.length ? done.reduce((a, t) => a + ((t.ended_at || 0) - (t.started_at || 0)), 0) / done.length : null,
      },
      spend: openrouter || null,
      agents_by_tier: byTier,
      manager_sessions: chat[0] || { sessions: 0, cost_usd: 0 },
      collector: collector ? { last_cycle_at: collector.last_cycle_at, last_cycle_ms: collector.last_cycle_ms, last_error: collector.last_error, lag_s: now() - (collector.last_cycle_at || 0) } : null,
    });
  });

  r.get("/tasks", async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const tasks = await col("tasks").find({}, { projection: { stages: 0 } }).sort({ started_at: -1 }).limit(limit).toArray();
    res.json(tasks);
  });

  r.get("/tasks/:id", async (req, res) => {
    const task = await col("tasks").findOne({ _id: req.params.id });
    if (!task) return res.status(404).json({ error: "task not found" });
    const agents = await col("agents").find({ task_id: task._id }).sort({ started_at: 1 }).toArray();
    const root = task.root_id ? await col("agents").findOne({ _id: task.root_id }) : null;
    res.json({ task, agents, root: root && { _id: root._id, model: root.model, tier: root.tier, title: root.title } });
  });

  r.get("/tasks/:id/logs", async (req, res) => {
    const task = await col("tasks").findOne({ _id: req.params.id }, { projection: { root_id: 1, started_at: 1, ended_at: 1 } });
    if (!task) return res.status(404).json({ error: "task not found" });
    const since = Number(req.query.since) || 0;
    const agentFilter = req.query.agent;
    const until = task.ended_at || now() + 60;
    const q = agentFilter
      ? { session_id: agentFilter, ts: { $gt: since } }
      : { $or: [{ task_id: task._id }, { session_id: task.root_id, ts: { $gte: task.started_at - 5, $lte: until } }], ts: { $gt: since } };
    const logs = await col("logs").find(q, { projection: { _id: 0 } }).sort({ ts: -1, n: -1 }).limit(Math.min(Number(req.query.limit) || 400, 2000)).toArray();
    res.json(logs.reverse());
  });

  r.get("/live", async (_req, res) => {
    const task = await col("tasks").findOne({ status: "running" }, { sort: { started_at: -1 } });
    const recent = await col("agents").find({ status: "running", depth: { $gte: 1 } }).sort({ started_at: -1 }).limit(20).toArray();
    res.json({ task, running_agents: recent });
  });

  return r;
}
