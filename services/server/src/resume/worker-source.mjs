import { register } from 'tsx/esm/api';

// Load only our small TypeScript modules through tsx. PDF.js dynamically imports
// a large worker module: transforming it can exceed the parser's RSS budget.
const unregister = register();
let worker;
try {
  worker = await import('./worker.ts');
} finally {
  await unregister();
}

// Parser dependencies load on receipt of input, after the loader is deactivated.
worker.startResumeWorker();
