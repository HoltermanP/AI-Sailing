import app from "./app.js";
import { config } from "./config.js";
import { log } from "./logger.js";

const server = app.listen(config.port, () => {
  log.info("server_start", { url: `http://localhost:${config.port}`, authRequired: !!config.apiKey });
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    log.info("server_stop", { signal: sig });
    server.close(() => process.exit(0));
  });
}
