import { MongoClient } from "mongodb";
import { createApp } from "./app.js";

const port = Number(process.env.PORT) || 3000;
let db = null;
let ready = false;

async function connect() {
  if (!process.env.MONGODB_URI) { console.error("MONGODB_URI not set"); return; }
  try {
    const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
    await client.connect();
    db = client.db();
    ready = true;
    client.on("serverHeartbeatFailed", () => { ready = false; });
    client.on("serverHeartbeatSucceeded", () => { ready = true; });
    console.log("mongo connected");
  } catch (e) {
    console.error("mongo connect failed:", e.message);
    setTimeout(connect, 5000);
  }
}
await connect();

createApp({
  getDb: () => { if (!db) throw new Error("database not connected"); return db; },
  user: process.env.MC_USER,
  pass: process.env.MC_PASS,
  dbReady: () => ready,
}).listen(port, "0.0.0.0", () => console.log(`mission control on :${port}`));
