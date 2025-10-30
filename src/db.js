import dotenv from 'dotenv';
import pkg from 'pg';
dotenv.config();
const { Pool } = pkg;
export const pool=new Pool({host:process.env.DB_HOST||'127.0.0.1',port:process.env.DB_PORT?Number(process.env.DB_PORT):5432,
 user:process.env.DB_USER||'postgres',password:process.env.DB_PASS||'',database:process.env.DB_NAME||'clearkhong'});
export async function query(text,params){ return pool.query(text,params); }