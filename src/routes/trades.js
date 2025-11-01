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
const textOnly = multer(); 

// ฟังก์ชันช่วยลบไฟล์ใน /uploads/trades/
function deleteUploadedFiles(files) {
  if (!files || !Array.isArray(files)) return;
  for (const f of files) {
    try {
      const filePath = path.join(process.cwd(), 'uploads', 'trades', f.filename);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        console.log('🗑️ Deleted file:', filePath);
      }
    } catch (err) {
      console.error('⚠️ Failed to delete file:', f.filename, err);
    }
  }
}

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
     WHERE t.proposer_id=$1
     GROUP BY t.id, t.status
     ORDER BY t.id DESC`,
    [req.user.id]   
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
  if (!post.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  if (post.rows[0].status !== 'approved')
    return res.status(400).json({ error: 'โพสต์นี้ยังไม่พร้อมสำหรับการเทรด' });
  if (post.rows[0].user_id === req.user.id){
    deleteUploadedFiles(req.files);   
    return res.status(400).json({ error: 'ไม่สามารถเสนอการเทรดในโพสต์ของตนเองได้' });
  }
  if (!post.rows[0].is_trade)
    return res.status(400).json({ error: 'โพสต์นี้ไม่รับการเทรด' });

  const existingTrade = await query(
    `SELECT tp.trade_id 
       FROM trade_posts tp 
       JOIN trades t ON t.id = tp.trade_id
      WHERE tp.post_id=$1 AND t.proposer_id=$2 AND t.status='pending'`,
    [pid, req.user.id]
  );
  if (existingTrade.rowCount) {
    deleteUploadedFiles(req.files);
    return res.status(400).json({ error: 'คุณได้เสนอการเทรดในโพสต์นี้ไปแล้ว' });
  }
  let items = buildItemsFromBody(req.body);

  if (!items.length) {
    items = req.body.items;
    if (typeof items === 'string') {
      try {
        items = JSON.parse(items);
      } catch (e) {
        return res.status(400).json({ error: 'รูปแบบรายการไม่ถูกต้อง' });
      }
    }
    if (!Array.isArray(items)) {
      if (items && typeof items === 'object') {
        items = [items];
      } else {
        return res.status(400).json({ error: 'รายการต้องเป็น array หรือ object' });
      }
    }
  }
  items = items.filter(
    (it) => it.title || it.description || (it.tags && it.tags.length)
  );
  if (!items.length) {
    return res.status(400).json({ error: 'ต้องมีรายการอย่างน้อย 1 รายการ' });
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
      deleteUploadedFiles(req.files); 
      return res
        .status(400)
        .json({ error: `Item index ${i} must have title and description` });
    }
    if (!Array.isArray(it.tags)) {
      it.tags = it.tags ? [it.tags] : [];
    }
    const imgs = filesByItem[i] || [];
    if (imgs.length < 4) {
      deleteUploadedFiles(req.files); 
      return res.status(400).json({
        error: `Each item must have at least 4 images. Item index ${i} has only ${imgs.length}`,
      });
    }
    if (imgs.length > 10) {
      deleteUploadedFiles(req.files);
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
    if (!Array.isArray(it.tags))
      continue;
    if (it.tags.some(tag => specialTags.includes(String(tag)))) {
      hasSpecial = true;
      break;
    }
  }
  //  แจ้งเตือนผู้ขาย
  if (hasSpecial) {
    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
      VALUES ($1, $2, $3, $4)`,
      [post.rows[0].user_id, 'การเสนอการเทรดที่ตรงกับแท็กพิเศษของคุณถูกส่งไปแล้ว!', pid, req.user.id]
    );
  } else {
    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
       VALUES ($1, $2, $3, $4)`,
      [post.rows[0].user_id, 'มีข้อเสนอการเทรดใหม่', pid, req.user.id]
    );    
  }

  res.json({ok:true, id:tradeId});
});

// ใช้ข้อเสนอการเทรดเดิม
router.post('/:postId/reuse/:tradeId', requireAuth, async (req, res) => {
  const pid = Number(req.params.postId);
  const tradeId = Number(req.params.tradeId);

  const post = await query('SELECT user_id, status, is_trade FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  if (post.rows[0].status !== 'approved')
    return res.status(400).json({ error: 'โพสต์นี้ยังไม่พร้อมสำหรับการเทรด' });
  if (post.rows[0].user_id === req.user.id)
    return res.status(400).json({ error: 'ไม่สามารถเสนอการเทรดในโพสต์ของตนเองได้' });
  if (!post.rows[0].is_trade) return res.status(400).json({ error: 'โพสต์นี้ไม่รับการเทรด' });

  if (!tradeId)
    return res.status(400).json({ error: 'ไม่มี Trade ID ที่ระบุ' });

  const tradeRes = await query(
    'SELECT id, proposer_id, status FROM trades WHERE id=$1',
    [tradeId]
  );

  if (!tradeRes.rowCount)
    return res.status(404).json({ error: 'ไม่พบ Trade' });

  const trade = tradeRes.rows[0];
  if (trade.proposer_id !== req.user.id || trade.status !== 'pending')
    return res.status(403).json({ error: 'ไม่สามารถใช้ Trade นี้ได้' });

  const existing = await query(
    'SELECT 1 FROM trade_posts WHERE trade_id=$1 AND post_id=$2',
    [tradeId, pid]
  );
  if (existing.rowCount)
    return res.status(400).json({ error: 'คุณได้เสนอการเทรดนี้ในโพสต์แล้ว' });

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
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
      VALUES ($1, $2, $3, $4)`,
      [post.rows[0].user_id, 'ข้อเสนอการเทรดที่ตรงกับแท็กพิเศษของคุณถูกส่งไปแล้ว!', pid, req.user.id]
    );
  } else {
    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
       VALUES ($1, $2, $3, $4)`,
      [post.rows[0].user_id, 'ข้อเสนอการเทรดใหม่', pid, req.user.id]
    );    
  }
  res.json({ ok: true, tradeId });
});


// ดึงข้อเสนอการเทรดทั้งหมดของโพสต์
router.get('/:postId', requireAuth, async (req, res) => {
  const pid = Number(req.params.postId);

  const post = await query('SELECT user_id FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount) {
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  }

  const isOwner = post.rows[0].user_id === req.user.id;

  const offersRes = await query(
    `
    SELECT 
      t.id, 
      t.proposer_id, 
      t.status, 
      u.username,
      u.profile_image_url,

      COALESCE(ROUND(AVG(sr.rating)::numeric, 1), 0) AS rating,
      COALESCE(COUNT(sr.rating), 0) AS review_count,

      json_agg(
        json_build_object(
          'title', ti.title,
          'description', ti.description,
          'tags', ti.tags,
          'images', ti.image_url
        )
      ) AS items

    FROM trades t
    JOIN trade_posts tp ON tp.trade_id = t.id
    JOIN users u ON u.id = t.proposer_id
    LEFT JOIN trade_items ti ON ti.trade_id = t.id
    LEFT JOIN seller_reviews sr ON sr.seller_id = u.id 
    WHERE tp.post_id=$1 ${isOwner ? '' : 'AND t.proposer_id=$2'}
    GROUP BY t.id, t.proposer_id, t.status, u.username, u.profile_image_url, u.id
    ORDER BY t.id DESC
    `,
    isOwner ? [pid] : [pid, req.user.id]
  );

  const offers = offersRes.rows.map(o => ({
    tradeId: o.id,
    proposerId: o.proposer_id,
    proposerName: o.username,
    proposerImage: o.profile_image_url,
    rating: o.rating,
    reviewCount: o.review_count, 
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
  if (!tradeRes.rowCount)
    return res.status(404).json({ error: 'ไม่พบการเทรด' });

  const trade = tradeRes.rows[0];
  if (trade.proposer_id !== req.user.id)
    return res.status(403).json({ error: 'คุณไม่สามารถลบการเทรดนี้ได้' });

  await query('DELETE FROM trade_items WHERE trade_id=$1', [tradeId]);
  await query('DELETE FROM trades WHERE id=$1', [tradeId]);

  res.json({ ok: true, message: 'ลบการเทรดเรียบร้อยแล้ว' });
});


// เจ้าของโพสต์ยอมรับข้อเสนอการเทรด + สร้าง trade_orders 1 แถว 
//A ยอมรับข้อเสนอการเทรด แต่ A ไม่มีที่อยู่จัดส่งสินค้าของ B ระบบเลยสร้าง order ของ B ไปหา A แทน
router.post('/:postId/accept/:offerId', requireAuth, textOnly.none(), async (req, res) => {
  const pid = Number(req.params.postId);
  const oid = Number(req.params.offerId);
  const ownerId = req.user.id;

  try {
    const post = await query(
      'SELECT user_id, status, is_trade FROM posts WHERE id=$1',
      [pid]
    );
    if (!post.rowCount) return res.status(404).json({ error: 'not found' });
    if (post.rows[0].user_id !== ownerId)
      return res.status(403).json({ error: 'คุณไม่สามารถยอมรับข้อเสนอการเทรดในโพสต์ของตนเองได้' });
    if (post.rows[0].status !== 'approved' || !post.rows[0].is_trade)
      return res.status(400).json({ error: 'โพสต์นี้ไม่สามารถทำการเทรดได้' });

    const offer = await query(
      `SELECT t.id AS trade_id, t.proposer_id, t.status
       FROM trades t
       JOIN trade_posts tp ON tp.trade_id = t.id
       WHERE t.id=$1 AND tp.post_id=$2`,
      [oid, pid]
    );
    if (!offer.rowCount)
      return res.status(404).json({ error: 'ไม่พบข้อเสนอการเทรด' });

    const { trade_id, proposer_id, status } = offer.rows[0];
    if (status !== 'pending')
      return res.status(400).json({ error: 'ข้อเสนอไม่อยู่ในสถานะรอการตอบรับ' });

    let { name, phone, address } = req.body;
    if (!address || !name || !phone) {
      const user = await query(
        'SELECT address, name, phone FROM users WHERE id=$1',
        [ownerId]
      );

      if (user.rowCount) {
        if (!address) address = user.rows[0].address || null;
        if (!name) name = user.rows[0].name || null;
        if (!phone) phone = user.rows[0].phone || null;
      }
    }

    if (phone && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'หมายเลขโทรศัพท์ต้องมี 10 หลัก' });
    }
    if (!address)
      return res.status(400).json({ error: 'จำเป็นต้องระบุที่อยู่จัดส่งสินค้า' });

    const updTrade = await query(
      `UPDATE trades SET status='accepted_waiting_confirm'
       WHERE id=$1 AND status='pending'
       RETURNING id`,
      [trade_id]
    );
    if (!updTrade.rowCount)
      return res.status(400).json({ error: 'การเทรดถูกยอมรับแล้วหรือไม่ถูกต้อง' });

    await query(
      `UPDATE posts SET status='waiting' WHERE id=$1`,
      [pid]
    );

    await query(
      `UPDATE trades 
       SET status='rejected'
       WHERE id <> $1
         AND id IN (SELECT tp.trade_id FROM trade_posts tp WHERE tp.post_id=$2)
         AND status='pending'`,
      [trade_id, pid]
    );

    // ตรวจว่ามี trade_orders เดิมอยู่ไหม
    const exists = await query(
      `SELECT id FROM trade_orders
       WHERE trade_id=$1 AND post_id=$2 AND sender_id=$3 AND receiver_id=$4`,
      [trade_id, pid, proposer_id, ownerId]
    );

    let tradeOrderId;
    if (exists.rowCount) {
      const upd = await query(
        `UPDATE trade_orders
         SET name=$1, phone=$2, address=$3, updated_at=NOW()
         WHERE id=$4 RETURNING id`,
        [name, phone, address, exists.rows[0].id]
      );
      tradeOrderId = upd.rows[0].id;
    } else {
      const ins = await query(
        `INSERT INTO trade_orders
         (trade_id, post_id, sender_id, receiver_id, status, name, phone, address)
         VALUES ($1,$2,$3,$4,'waiting_shipping',$5,$6,$7)
         RETURNING id`,
        [trade_id, pid, proposer_id, ownerId, name, phone, address]
      );
      tradeOrderId = ins.rows[0].id;
    }

    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
       VALUES ($1,$2,$3,$4)`,
      [proposer_id, 'ข้อเสนอการเทรดของคุณถูกยอมรับแล้ว กรุณายืนยันเพื่อดำเนินการต่อ', pid, ownerId]
    );

    res.json({
      ok: true,
      message: 'Trade accepted, waiting proposer to confirm',
      tradeOrderId,
      post_id: pid
    });
  } catch (err) {
    console.error('เกิดข้อผิดพลาดในการยอมรับการเทรด:', err);
    res.status(500).json({ error: 'server error' });
  }
});



// ดึง trade เดียวตาม id (เพิ่ม profile_image_url, rating, review_count)
router.get('/:id/detail', requireAuth, async (req, res) => {
  const tradeId = Number(req.params.id);
  const userId = req.user.id;

  const result = await query(`
    SELECT 
      t.id, 
      t.status, 
      t.proposer_id, 
      u.username, 
      u.profile_image_url,
      COALESCE(ROUND(AVG(sr.rating)::numeric, 1), 0) AS rating,
      COALESCE(COUNT(sr.rating), 0) AS review_count,
      json_agg(
        json_build_object(
          'title', ti.title,
          'description', ti.description,
          'tags', ti.tags,
          'images', ti.image_url
        )
      ) AS items
    FROM trades t
    JOIN users u ON u.id = t.proposer_id
    LEFT JOIN trade_items ti ON ti.trade_id = t.id
    LEFT JOIN seller_reviews sr ON sr.seller_id = u.id 
    WHERE t.id = $1
    GROUP BY t.id, t.status, t.proposer_id, u.username, u.profile_image_url
  `, [tradeId]);

  if (!result.rowCount)
    return res.status(404).json({ error: 'ไม่พบข้อเสนอเทรด' });

  const trade = result.rows[0];

  // ตรวจสอบสิทธิ์: ผู้เสนอเทรดหรือเจ้าของโพสต์เท่านั้น
  const post = await query(`
    SELECT p.user_id
    FROM trade_posts tp
    JOIN posts p ON tp.post_id = p.id
    WHERE tp.trade_id = $1
  `, [tradeId]);

  if (post.rowCount && post.rows[0].user_id !== userId && trade.proposer_id !== userId) {
    return res.status(403).json({ error: 'ไม่มีสิทธิ์เข้าถึง trade นี้' });
  }

  res.json({
    id: trade.id,
    status: trade.status,
    proposer: {
      id: trade.proposer_id,
      username: trade.username,
      profile_image_url: trade.profile_image_url,
      rating: parseFloat(trade.rating) || 0,
      review_count: parseInt(trade.review_count) || 0
    },
    items: trade.items.map(it => ({
      title: it.title,
      description: it.description,
      tags: it.tags || [],
      images: (() => {
        try { return JSON.parse(it.images || '[]'); } catch { return []; }
      })()
    })),
  });
});

// // เจ้าของโพสต์ยอมรับข้อเสนอการเทรด (แต่ยังไม่ปิดโพสต์และไม่สร้าง order)
// router.post('/:postId/accept/:offerId', requireAuth, async (req,res)=>{
//   const pid = Number(req.params.postId);
//   const oid = Number(req.params.offerId);

//   const post = await query('SELECT user_id, status, is_trade FROM posts WHERE id=$1', [pid]);
//   if (!post.rowCount) return res.status(404).json({ error: 'not found' });
//   if (post.rows[0].user_id !== req.user.id) return res.status(403).json({ error: 'forbidden' });
//   if (post.rows[0].status !== 'approved' || !post.rows[0].is_trade)
//     return res.status(400).json({ error: 'post is not tradable' });

//   // 👇 เปลี่ยนมาใช้ JOIN ผ่าน trade_posts
//   const offer = await query(
//     `SELECT t.proposer_id, t.status 
//      FROM trades t
//      JOIN trade_posts tp ON tp.trade_id = t.id
//      WHERE t.id = $1 AND tp.post_id = $2`,
//     [oid, pid]
//   );

//   if (!offer.rowCount) return res.status(404).json({ error: 'offer not found' });
//   if (offer.rows[0].status !== 'pending') return res.status(400).json({ error: 'offer not pending' });

//   // 👉 ตอนนี้เปลี่ยนเฉพาะ trade เป็น accepted
//   await query('UPDATE trades SET status=$1 WHERE id=$2',['accepted',oid]);

//   // แจ้งเตือน proposer
//   await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2)`,
//     [offer.rows[0].proposer_id,'Your trade offer has been accepted. Please confirm to proceed.']);

//   res.json({ok:true, message: 'Trade accepted, waiting proposer to confirm'});
// });

export default router;