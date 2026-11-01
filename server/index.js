import path from 'node:path';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { startScheduler } from './scheduler.js';

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.resolve(process.env.DATA_DIR || 'data');

const db = openDb(DATA_DIR);
const app = createApp(db);

startScheduler(db);

app.listen(PORT, () => {
  console.log(`Task tracker running at http://localhost:${PORT}  (data: ${DATA_DIR})`);
});
