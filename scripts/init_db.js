import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { query, pool } from '../src/db.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const schema=fs.readFileSync(path.resolve(__dirname, '../../database/schema.sql'), 'utf-8');
(async () => {
    try {
        await query(schema);
        console.log('✅ DB initialized');
    } catch (e) { console.error(e); }
    finally { await pool.end(); }
})();