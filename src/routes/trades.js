import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router=Router();
const tradeDir = path.join(process.cwd(), 'uploads', 'trades');
if (!fs.existsSync(tradeDir))
  fs.mkdirSync(tradeDir, { recursive: true });
const storage=multer.diskStorage({destination:(r,f,cb)=>cb(null,tradeDir),filename:(r,f,cb)=>cb(null,Date.now()+'-'+Math.round(Math.random()*1e9)+path.extname(f.originalname))});
const upload=multer({storage});

// แสดงข้อเสนอเทรดทั้งหมดของ user (my-trades)
router.get('/my-trades', requireAuth, async (req, res) => {
  const tradesRes = await query(
    `SELECT t.id, t.status,
            json_agg(json_build_object(
              'title', ti.title,
              'description', ti.description,
              'tags', ti.tags,
              'images', ti.image_url
            )) AS items
     FROM trades t
     LEFT JOIN trade_items ti ON ti.trade_id = t.id
     WHERE t.proposer_id=$1 AND t.status=$2
     GROUP BY t.id, t.status
     ORDER BY t.id DESC`,
    [req.user.id, 'pending']
  );

  if (!tradesRes.rowCount) {
    return res.json({ trades: [] });
  }

  const trades = tradesRes.rows.map(t => ({
    id: t.id,
    status: t.status,
    items: t.items.map(item => ({
      title: item.title,
      description: item.description,
      tags: item.tags || [],
      images: (() => {
        try {
          return JSON.parse(item.images || '[]');
        } catch (e) {
          return [];
        }
      })()
    }))
  }));

  res.json({ trades });
});


function buildItemsFromBody(body) {
  const items = {};

  for (const key in body) {
    const match = key.match(/^items\[(\d+)\]\.(.+)$/);
    if (match) {
      const index = Number(match[1]);
      const field = match[2];

      if (!items[index]) items[index] = {};
      if (items[index][field] !== undefined) {
        if (!Array.isArray(items[index][field])) {
          items[index][field] = [items[index][field]];
        }
        items[index][field].push(body[key]);
      } else {
        items[index][field] = body[key];
      }
    }
  }

  return Object.keys(items)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => items[k]);
}

// สร้างข้อเสนอการเทรดใหม่
router.post('/:postId/new', requireAuth, upload.any(), async (req,res)=>{
  const pid = Number(req.params.postId);

  const post = await query('SELECT user_id, status, is_trade FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount) return res.status(404).json({ error: 'not found' });
  if (post.rows[0].status !== 'approved') return res.status(400).json({ error: 'The post is not ready for trading yet.' });
  if (post.rows[0].user_id === req.user.id) return res.status(400).json({ error: 'cannot offer trade on your own post' });
  if (!post.rows[0].is_trade) return res.status(400).json({ error: 'this post does not accept trades' });

  const existingTrade = await query(
    `SELECT tp.trade_id 
       FROM trade_posts tp 
       JOIN trades t ON t.id = tp.trade_id
      WHERE tp.post_id=$1 AND t.proposer_id=$2 AND t.status='pending'`,
    [pid, req.user.id]
  );
  if (existingTrade.rowCount) {
    return res.status(400).json({ error: 'You have already offered a trade for this post' });
  }
  let items = buildItemsFromBody(req.body);

  if (!items.length) {
    items = req.body.items;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid items format' });
      }
    }
    if (!Array.isArray(items)) {
      if (items && typeof items === 'object') {
        items = [items];
      } else {
        return res.status(400).json({ error: 'Items must be an array or object' });
      }
    }
  }
  items = items.filter(
    (it) => it.title || it.description || (it.tags && it.tags.length)
  );
  if (!items.length) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  const filesByItem = {};
  if (req.files) {
    for (const f of req.files) {
      // รองรับทั้ง items[0].images และ items[0][images][0]
      const match = f.fieldname.match(/^items\[(\d+)\](?:\.images|\[images\](?:\[(\d+)\])?)$/);
      if (match) {
        const idx = Number(match[1]);
        if (!filesByItem[idx]) filesByItem[idx] = [];
        filesByItem[idx].push('/uploads/trades/' + f.filename);
      }
    }
  }
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.title || !it.description) {
      return res
        .status(400)
        .json({ error: `Item index ${i} must have title and description` });
    }
    if (!Array.isArray(it.tags)) {
      it.tags = it.tags ? [it.tags] : [];
    }
    const imgs = filesByItem[i] || [];
    if (imgs.length < 4) {
      return res.status(400).json({
        error: `Each item must have at least 4 images. Item index ${i} has only ${imgs.length}`,
      });
    }
    if (imgs.length > 10) {
      return res.status(400).json({
        error: `Each item can have at most 10 images. Item index ${i} has ${imgs.length}`,
      });
    }
  }

  const r = await query(
    `INSERT INTO trades (proposer_id, status)
    VALUES ($1, 'pending') RETURNING id`,
    [req.user.id]
  );

  const tradeId = r.rows[0].id;

  await query(
    'INSERT INTO trade_posts (trade_id, post_id) VALUES ($1, $2)',
    [tradeId, pid]
  );


  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const imgs = filesByItem[i] || [];
    await query(
      `INSERT INTO trade_items (trade_id, title, description, tags, image_url)
      VALUES ($1,$2,$3,$4,$5)`,
      [tradeId, it.title, it.description, it.tags, JSON.stringify(imgs)]
    );
  }

  const postTagsRes = await query('SELECT special_tags FROM posts WHERE id=$1', [pid]);
  let specialTags = [];
  if (postTagsRes.rowCount && Array.isArray(postTagsRes.rows[0].special_tags)) {
    specialTags = postTagsRes.rows[0].special_tags.map(String);
  }

  let hasSpecial = false;
  for (const it of items) {
    if (!Array.isArray(it.tags)) continue;
    if (it.tags.some(tag => specialTags.includes(String(tag)))) {
      hasSpecial = true;
      break;
    }
  }
  //  แจ้งเตือนผู้ขาย
  if (hasSpecial) {
    await query(
      `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
      [post.rows[0].user_id, 'A trade offer matching your special tags was just submitted!']
    );
  } else {
    await query(
      `INSERT INTO notifications (user_id,message) VALUES ($1,$2)`,
      [post.rows[0].user_id,'New offer for trading']
    );
  }

  res.json({ok:true, id:tradeId});
});

// ใช้ข้อเสนอการเทรดเดิม
router.post('/:postId/reuse/:tradeId', requireAuth, async (req, res) => {
  const pid = Number(req.params.postId);
  const tradeId = Number(req.params.tradeId);

  const post = await query('SELECT user_id, status, is_trade FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount) return res.status(404).json({ error: 'not found' });
  if (post.rows[0].status !== 'approved') return res.status(400).json({ error: 'The post is not ready for trading yet.' });
  if (post.rows[0].user_id === req.user.id) return res.status(400).json({ error: 'cannot offer trade on your own post' });
  if (!post.rows[0].is_trade) return res.status(400).json({ error: 'this post does not accept trades' });

  if (!tradeId) return res.status(400).json({ error: 'No trade ID provided' });

  const tradeRes = await query(
    'SELECT id, proposer_id, status FROM trades WHERE id=$1',
    [tradeId]
  );

  if (!tradeRes.rowCount) return res.status(404).json({ error: 'Trade not found' });

  const trade = tradeRes.rows[0];
  if (trade.proposer_id !== req.user.id || trade.status !== 'pending') 
    return res.status(403).json({ error: 'You cannot use this trade' });

  const existing = await query(
    'SELECT 1 FROM trade_posts WHERE trade_id=$1 AND post_id=$2',
    [tradeId, pid]
  );
  if (existing.rowCount) return res.status(400).json({ error: 'You have already offered this trade to this post' });

  await query(
    'INSERT INTO trade_posts (trade_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [tradeId, pid]
  );

  const postTagsRes = await query('SELECT special_tags FROM posts WHERE id=$1', [pid]);
  let specialTags = [];
  if (postTagsRes.rowCount && Array.isArray(postTagsRes.rows[0].special_tags)) {
    specialTags = postTagsRes.rows[0].special_tags.map(String);
  }
  
  let hasSpecial = false;
  if (specialTags.length > 0) {
    const tradeItemsRes = await query(
      'SELECT tags FROM trade_items WHERE trade_id=$1',
      [tradeId]
    );
    for (const row of tradeItemsRes.rows) {
      const tags = Array.isArray(row.tags) ? row.tags : [];
      if (tags.some(tag => specialTags.includes(String(tag)))) {
        hasSpecial = true;
        break;
      }
    }
  }
  //  แจ้งเตือนผู้ขาย
  if (hasSpecial) {
    await query(
      `INSERT INTO notifications (user_id, message) VALUES ($1, $2)`,
      [post.rows[0].user_id, 'A trade offer matching your special tags was just submitted!']
    );
  } else {
    await query(
      `INSERT INTO notifications (user_id,message) VALUES ($1,$2)`,
      [post.rows[0].user_id,'New offer for trading']
    );
  }
  res.json({ ok: true, tradeId });
});


// ดึงข้อเสนอการเทรดทั้งหมดของโพสต์
router.get('/:postId', requireAuth, async (req, res) => {
  const pid = Number(req.params.postId);

  const post = await query('SELECT user_id FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount) {
    return res.status(404).json({ error: 'not found' });
  }

  const isOwner = post.rows[0].user_id === req.user.id;

  const offersRes = await query(
    `SELECT t.id, t.proposer_id, t.status, u.username,
            json_agg(json_build_object(
              'title', ti.title,
              'description', ti.description,
              'tags', ti.tags,
              'images', ti.image_url
            )) AS items
     FROM trades t
     JOIN trade_posts tp ON tp.trade_id = t.id
     JOIN users u ON u.id = t.proposer_id
     LEFT JOIN trade_items ti ON ti.trade_id = t.id
     WHERE tp.post_id=$1 ${isOwner ? '' : 'AND t.proposer_id=$2'}
     GROUP BY t.id, t.proposer_id, t.status, u.username
     ORDER BY t.id DESC`,
    isOwner ? [pid] : [pid, req.user.id]
  );

  const offers = offersRes.rows.map(o => ({
    tradeId: o.id,
    proposerId: o.proposer_id,
    proposerName: o.username,
    status: o.status,
    items: o.items.map(item => ({
      title: item.title,
      description: item.description,
      tags: item.tags || [],
      images: (() => {
        try {
          return JSON.parse(item.images || '[]');
        } catch (e) {
          return [];
        }
      })()
    }))
  }));

  res.json({ offers, isOwner });
});
 
// ลบข้อเสนอการเทรดทั้งหมด (โดยผู้เสนอเทรด)
router.delete('/:tradeId', requireAuth, async (req, res) => {
  const tradeId = Number(req.params.tradeId);

  if (isNaN(tradeId)) {
    return res.status(400).json({ error: 'Invalid trade ID5' });
  }

  const tradeRes = await query('SELECT id, proposer_id FROM trades WHERE id=$1', [tradeId]);
  if (!tradeRes.rowCount) return res.status(404).json({ error: 'Trade not found' });

  const trade = tradeRes.rows[0];
  if (trade.proposer_id !== req.user.id) 
    return res.status(403).json({ error: 'You cannot delete this trade' });

  await query('DELETE FROM trade_items WHERE trade_id=$1', [tradeId]);
  await query('DELETE FROM trades WHERE id=$1', [tradeId]);

  res.json({ ok: true, message: 'Trade deleted successfully' });
});

// เจ้าของโพสต์ยอมรับข้อเสนอการเทรด (แต่ยังไม่ปิดโพสต์และไม่สร้าง order)
router.post('/:postId/accept/:offerId', requireAuth, async (req,res)=>{
  const pid = Number(req.params.postId);
  const oid = Number(req.params.offerId);

  const post = await query('SELECT user_id, status, is_trade FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount) return res.status(404).json({ error: 'not found' });
  if (post.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
  if (post.rows[0].status !== 'approved' || !post.rows[0].is_trade)
    return res.status(400).json({ error: 'post is not tradable' });

  // 👇 เปลี่ยนมาใช้ JOIN ผ่าน trade_posts
  const offer = await query(
    `SELECT t.proposer_id, t.status 
     FROM trades t
     JOIN trade_posts tp ON tp.trade_id = t.id
     WHERE t.id = $1 AND tp.post_id = $2`,
    [oid, pid]
  );

  if (!offer.rowCount) return res.status(404).json({ error: 'offer not found' });
  if (offer.rows[0].status !== 'pending') return res.status(400).json({ error: 'offer not pending' });

  // 👉 ตอนนี้เปลี่ยนเฉพาะ trade เป็น accepted
  await query('UPDATE trades SET status=$1 WHERE id=$2',['accepted',oid]);

  // แจ้งเตือน proposer
  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2)`,
    [offer.rows[0].proposer_id,'Your trade offer has been accepted. Please confirm to proceed.']);

  res.json({ok:true, message: 'Trade accepted, waiting proposer to confirm'});
});



export default router;