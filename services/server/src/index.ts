import 'dotenv/config';
import { loadConfig } from './config.js';
import { createInterviewServer } from './server.js';

try {
  const config = loadConfig();
  const server = createInterviewServer(config);
  const port = await server.listen();
  console.log(`Interview assistant listening on ${config.HOST}:${port}`);
  if (!config.APP_ACCESS_TOKEN) console.warn('Local development: no app access token configured. Bind only to a trusted local interface.');
  let stopping = false;
  const shutdown = () => { if (stopping) return; stopping = true; void server.close().then(() => process.exit(0)); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Server startup failed.');
  process.exitCode = 1;
}
