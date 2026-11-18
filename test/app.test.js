import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/app.js";

function fakeDb(data) {
  const cursor = (rows) => ({
    sort() { return this; }, limit() { return this; }, project() { return this; },
    toArray: async () => rows,
  });
  return {
    collection: (name) => ({
      find: () => cursor(data[name] || []),
      findOne: async (q) => (data[name] || []).find((d) => !q?._id || d._id === q._id) || null,
      aggregate: () => cursor([]),
    }),
  };
}

async function withServer(app, fn) {
  const server = app.listen(0);
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { server.close(); }
}

test("health is public and reports mongo state", async () => {
  await withServer(createApp({ getDb: () => fakeDb({}), user: "u", pass: "p", dbReady: () => false }), async (base) => {
    const r = await fetch(`${base}/health`);
    assert.equal(r.status, 503);
    assert.equal((await r.json()).mongo, "error");
  });
});

test("api and UI require basic auth", async () => {
  await withServer(createApp({ getDb: () => fakeDb({}), user: "u", pass: "p" }), async (base) => {
    assert.equal((await fetch(`${base}/api/tasks`)).status, 401);
    assert.equal((await fetch(`${base}/`)).status, 401);
    const ok = await fetch(`${base}/api/tasks`, { headers: { Authorization: "Basic " + Buffer.from("u:p").toString("base64") } });
    assert.equal(ok.status, 200);
    const bad = await fetch(`${base}/api/tasks`, { headers: { Authorization: "Basic " + Buffer.from("u:x").toString("base64") } });
    assert.equal(bad.status, 401);
  });
});

test("task detail returns 404 for unknown task", async () => {
  await withServer(createApp({ getDb: () => fakeDb({ tasks: [] }) }), async (base) => {
    assert.equal((await fetch(`${base}/api/tasks/nope`)).status, 404);
  });
});

test("summary aggregates task counts", async () => {
  const db = fakeDb({ tasks: [{ _id: "a", status: "done", cost_usd: 1, started_at: 0, ended_at: 60 }, { _id: "b", status: "running", started_at: 10 }] });
  await withServer(createApp({ getDb: () => db }), async (base) => {
    const s = await (await fetch(`${base}/api/summary`)).json();
    assert.equal(s.tasks.total, 2);
    assert.equal(s.tasks.done, 1);
    assert.equal(s.tasks.running, 1);
    assert.equal(s.tasks.avg_cost_usd, 1);
  });
});
