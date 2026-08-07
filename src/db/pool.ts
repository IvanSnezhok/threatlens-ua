import pg from 'pg';
import { config } from '../config.js';

const { Pool } = pg;
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: config.NODE_ENV === 'test' ? 2 : 12,
  statement_timeout: 15_000,
  application_name: 'threatlens-ua'
});
