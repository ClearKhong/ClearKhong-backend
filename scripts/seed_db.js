import bcrypt from 'bcryptjs';
import { query, pool } from '../src/db.js';

const IMG =
  'https://www.apple.com/v/iphone/home/cc/images/overview/consider_modals/environment/modal_trade_in_variant__ejij0q8th06e_large.jpg';

async function upsertUser(username, role = 'user') {
  const hash = await bcrypt.hash(username, 10);
  const inserted = await query(
    `INSERT INTO users (username, password_hash, role, tokens, is_active)
     VALUES ($1, $2, $3, 100, true)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [username, hash, role]
  );
  if (inserted.rows.length) return inserted.rows[0].id;
  const r = await query('SELECT id FROM users WHERE username=$1', [username]);
  return r.rows[0].id;
}

async function insertPostIfNotExists(p) {
  await query(
    `INSERT INTO posts
       (user_id, title, description, price, is_sell, is_trade, tags, image_url, status, promoted)
     SELECT
       $1::int,
       $2::varchar,
       $3::text,
       $4::numeric,
       $5::boolean,
       $6::boolean,
       $7::text[],
       $8::text,
       $9::post_status,
       false
     WHERE NOT EXISTS (
       SELECT 1 FROM posts
        WHERE user_id = $1::int
          AND title   = $2::varchar
     )`,
    [
      p.user_id,
      p.title,
      p.description,
      p.price,
      p.is_sell,
      p.is_trade,
      p.tags,
      IMG,
      p.status
    ]
  );
}

async function run() {
  const users = [
    { name: 'admin', role: 'admin' },
    { name: 'alice', role: 'user' },
    { name: 'bob', role: 'user' },
    { name: 'charlie', role: 'user' },
    { name: 'diana', role: 'user' },
    { name: 'eve', role: 'user' },
  ];

  const ids = {};
  for (const u of users) ids[u.name] = await upsertUser(u.name, u.role);

  const posts = [
    { user_id: ids['alice'],   title: 'Vintage Camera',     description: 'Great condition', price: 1200, is_sell: true,  is_trade: false, tags: ['electronics'], status: 'approved' },
    { user_id: ids['bob'],     title: 'Running Shoes',      description: 'Like new',        price: 80,   is_sell: true,  is_trade: false, tags: ['sports'],      status: 'approved' },
    { user_id: ids['charlie'], title: 'Trade: Board Game',  description: 'Trade only',      price: null, is_sell: false, is_trade: true,  tags: ['toys'],        status: 'approved' },
    { user_id: ids['diana'],   title: 'Trade: Headphones',  description: 'Trade for books', price: null, is_sell: false, is_trade: true,  tags: ['electronics'], status: 'approved' },
    { user_id: ids['eve'],     title: 'Laptop or Trade',    description: 'Sell or trade',   price: 900,  is_sell: true,  is_trade: true,  tags: ['electronics'], status: 'pending' },
  ];
  for (const p of posts) await insertPostIfNotExists(p);

  console.log('✅ Seeded (non-destructive, idempotent)');
}

run().catch(console.error).finally(() => pool.end());