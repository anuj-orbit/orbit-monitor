import express from "express";
import { fileURLToPath } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { apiRouter } from "./api.js";

function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function basicAuth(user, pass) {
  return (req, res, next) => {
    if (!user || !pass) return next();
    const [scheme, encoded] = (req.headers.authorization || "").split(" ");
    if (scheme === "Basic" && encoded) {
      const [u, ...rest] = Buffer.from(encoded, "base64").toString().split(":");
      if (safeEqual(u, user) && safeEqual(rest.join(":"), pass)) return next();
    }
    res.set("WWW-Authenticate", 'Basic realm="Orbit Mission Control"').status(401).send("Authentication required");
  };
}

export function createApp({ getDb, user, pass, dbReady = () => true }) {
  const app = express();
  app.disable("x-powered-by");
  app.get("/health", (_req, res) => {
    const ok = dbReady();
    res.status(ok ? 200 : 503).json({ status: ok ? "ok" : "degraded", mongo: ok ? "connected" : "error" });
  });
  app.use(basicAuth(user, pass));
  app.use("/api", apiRouter(getDb));
  app.use(express.static(fileURLToPath(new URL("../public", import.meta.url)), { maxAge: "1m" }));
  app.use("/api", (err, _req, res, _next) => res.status(500).json({ error: err.message }));
  return app;
}
