import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router=Router();
const postDir=path.join(process.cwd(),'uploads','posts'); 
if(!fs.existsSync(postDir)) 
  fs.mkdirSync(postDir,{recursive:true});
const storage=multer.diskStorage({destination:(r,f,cb)=>cb(null,postDir),filename:(r,f,cb)=>cb(null,Date.now()+'-'+Math.round(Math.random()*1e9)+path.extname(f.originalname))});
const upload=multer({storage});

// Helper to call upload.array and convert multer errors to HTTP 400 with friendly messages
function multerArray(field, max) {
  return (req, res, next) => {
    upload.array(field, max)(req, res, function (err) {
      if (err) {
        // Multer throws MulterError for file count/field issues
        if (err && (err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT' || err.message && err.message.indexOf('Unexpected field') !== -1)) {
          return res.status(400).json({ error: 'Images must be between 4 and 10 files' });
        }
        return next(err);
      }
      next();
    });
  };
}
const DEFAULT_IMG='https://www.apple.com/v/iphone/home/cc/images/overview/consider_modals/environment/modal_trade_in_variant__ejij0q8th06e_large.jpg';

const slipDir = path.join(process.cwd(), 'uploads', 'slips');
if (!fs.existsSync(slipDir)) fs.mkdirSync(slipDir, { recursive: true });

const slipStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, slipDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname))
});

const uploadSlip = multer({ storage: slipStorage });

// ดึงโพสต์ทั้งหมด (ค้นหา/กรองได้ + แสดงผลตามตัวอักษร (1. ขึ้นต้น 2. มีในชื่อ 3. มีในแท็ก))
router.get('/', async (req, res) => {
  const { q, tag } = req.query;
  let sql = `
    SELECT p.*, 
      u.username AS seller_username, 
      u.profile_image_url AS seller_profile_image_url, 
      COALESCE(ROUND(AVG(sr.rating)::numeric, 1), 0) AS seller_rating,
      COALESCE(COUNT(sr.rating), 0) AS review_count,
      CASE 
        -- 3 ระดับความสำคัญ
        WHEN LOWER(p.title) LIKE LOWER($1 || '%') THEN 3            -- ขึ้นต้นด้วยคำค้น
        WHEN LOWER(p.title) LIKE LOWER('%' || $1 || '%') THEN 2     -- มีในชื่อ
        WHEN EXISTS (
          SELECT 1 FROM unnest(p.tags) AS t WHERE LOWER(t) LIKE LOWER('%' || $1 || '%')
        ) THEN 1                                                    -- มีในแท็ก
        ELSE 0
      END AS relevance
    FROM posts p
    JOIN users u ON u.id = p.user_id
    LEFT JOIN seller_reviews sr ON sr.seller_id = p.user_id
    WHERE p.status = 'approved'
  `;

  const ps = [q || ''];

  // ถ้ามี tag filter แยกต่างหาก
  if (tag) {
    ps.push(tag.toLowerCase());
    sql += `
      AND EXISTS (
        SELECT 1 FROM unnest(p.tags) AS t 
        WHERE LOWER(t) = $${ps.length}
      )
    `;
  }

  // เงื่อนไขค้นหาหลัก
  sql += `
    AND (
      $1 = ''
      OR LOWER(p.title) LIKE LOWER('%' || $1 || '%')
      OR EXISTS (
        SELECT 1 FROM unnest(p.tags) AS t 
        WHERE LOWER(t) LIKE LOWER('%' || $1 || '%')
      )
    )
    GROUP BY p.id, u.username, u.profile_image_url
    ORDER BY relevance DESC, p.promoted_at DESC NULLS LAST, p.created_at DESC
  `;

  try {
    const r = await query(sql, ps);
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});

// ดึงรายละเอียดโพสต์ตาม id
router.get('/:id', async (req, res) => {
  const sql = `
  SELECT p.*, 
       u.id AS seller_id, 
       u.username AS seller_username, 
       u.profile_image_url AS seller_profile_image_url,
       COALESCE(ROUND(AVG(sr.rating)::numeric, 1), 0) AS seller_rating,
       COALESCE(COUNT(sr.rating), 0) AS review_count
    FROM posts p 
    JOIN users u ON u.id = p.user_id 
    LEFT JOIN seller_reviews sr ON sr.seller_id = p.user_id
    WHERE p.id = $1
    GROUP BY p.id, u.id, u.username, u.profile_image_url
  `;
  const r = await query(sql, [req.params.id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  res.json(r.rows[0]);
});

// สร้างโพสต์ใหม่ (อัปโหลดรูปได้ ต้องล็อกอิน)
router.post('/', requireAuth, multerArray('images', 10), async (req,res)=>{
  const { title, description } = req.body;
  const isSell = ['true', 'on', '1', 'yes'].includes(String(req.body.is_sell).toLowerCase());
  const isTrade = ['true', 'on', '1', 'yes'].includes(String(req.body.is_trade).toLowerCase());
  const price = req.body.price ? Number(req.body.price) : null;
  const raw = req.body.tags;
  let tags = [];
  if (Array.isArray(raw))
    tags = raw.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  else if (typeof raw === 'string')
    tags = raw.split(',').map(s => s.trim()).filter(Boolean);
  // special_tags behaves like tags but is optional and starts empty by default
  const rawSpecial = req.body.special_tags;
  let special_tags = [];
  if (Array.isArray(rawSpecial))
    special_tags = rawSpecial.flatMap(v => String(v).split(',')).map(s => s.trim()).filter(Boolean);
  else if (typeof rawSpecial === 'string')
    special_tags = rawSpecial.split(',').map(s => s.trim()).filter(Boolean);
  // enforce 4-10 uploaded images
  const uploaded = req.files || [];
  if (!uploaded.length)
    return res.status(400).json({ error: 'ต้องอัปโหลดระหว่าง 4 ถึง 10 รูปภาพ' });
  if (uploaded.length < 4 || uploaded.length > 10)
    return res.status(400).json({ error: 'ต้องอัปโหลดระหว่าง 4 ถึง 10 รูปภาพ' });
  const images = uploaded.map(f => ('/uploads/posts/'+f.filename));
  const image = JSON.stringify(images)
  if (!title || !description || (!isSell && !isTrade))
    return res.status(400).json({ error: 'Incomplete information' });
  if (isSell && (price === null || Number.isNaN(price) || price <= 0))
    return res.status(400).json({ error: 'Price must be a positive number' });
  const r=await query(`INSERT INTO posts (user_id,title,description,price,is_sell,is_trade,tags,special_tags,image_url,status,promoted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pending',false) RETURNING id`,
   [req.user.id,title,description,price,isSell,isTrade,tags,special_tags,image]);
  res.json({ok:true,postId:r.rows[0].id}); });

// ซื้อสินค้า (ต้องล็อกอิน)
router.post('/:id/buy', requireAuth, uploadSlip.single('payment_slip_url'), async (req, res) => {
  const post_id = Number(req.params.id);
  const buyer_id = req.user.id;
  let { name, phone, address } = req.body; 

  if (!post_id)
    return res.status(400).json({ error: 'ต้องระบุ postId' });

  if (!req.file)
    return res.status(400).json({ error: 'ต้องแนบสลิปการชำระเงิน (1 ไฟล์)' });

  const uploadPath = '/uploads/slips/' + req.file.filename; 

 // ดึงข้อมูลจาก users ถ้าไม่ได้ส่งมา
 if (!address || !name || !phone) {
  const user = await query(
    'SELECT address, name, phone FROM users WHERE id=$1',
    [buyer_id]
  );

  if (user.rowCount) {
    if (!address) address = user.rows[0].address || null;
    if (!name) name = user.rows[0].name || null;
    if (!phone) phone = user.rows[0].phone || null;
  }
}
  const postRes = await query('SELECT user_id, price, status FROM posts WHERE id=$1', [post_id]);
  if (!postRes.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });

  const seller_id = postRes.rows[0].user_id;
  const amount = postRes.rows[0].price || 0;

  if (seller_id === buyer_id)
    return res.status(400).json({ error: 'ไม่สามารถซื้อโพสต์ของตัวเองได้' });
  if (postRes.rows[0].status !== 'approved')
    return res.status(400).json({ error: 'ไม่สามารถซื้อโพสต์นี้ได้' });

  // ตรวจสอบ order ซ้ำ
  const existing = await query('SELECT 1 FROM orders WHERE post_id=$1 AND buyer_id=$2', [post_id, buyer_id]);
  if (existing.rowCount) return res.status(400).json({ error: 'มีคำสั่งซื้ออยู่แล้ว' });

  const orderRes = await query(
    `INSERT INTO orders (post_id, buyer_id, seller_id, status, name, phone, address, payment_slip_url, amount)
     VALUES ($1,$2,$3,'waiting_confirm',$4,$5,$6,$7,$8) RETURNING *`,
    [post_id, buyer_id, seller_id, name, phone, address, uploadPath, amount]
  );

  await query(
    `UPDATE posts SET status='closed' WHERE id=$1`,
    [post_id]
  );
  
  // แจ้งเตือนผู้ขาย
  await query('INSERT INTO notifications (user_id, message, post_id, actor_id) VALUES ($1,$2,$3,$4)',
    [seller_id, 'มีคำสั่งซื้อใหม่รอการยืนยัน กรุณาตรวจสอบสลิปการชำระเงิน',
      post_id,
      buyer_id
    ]
  );

  res.json({ ok: true, order: orderRes.rows[0] });
});

// โปรโมทโพสต์ (ต้องล็อกอิน)
router.post('/:id/promote', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const cost = 20;
  const post = await query(`SELECT user_id,status,promoted FROM posts WHERE id=$1`, [id]);
  if (!post.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  const p = post.rows[0];
  if (p.user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  if (p.status !== 'approved')
    return res.status(400).json({ error: 'โพสต์ต้องได้รับการอนุมัติก่อนที่จะโปรโมท' });
  if (p.promoted)
    return res.status(400).json({ error: 'โพสต์นี้ได้รับการโปรโมทแล้ว' });

  const bal = await query(`SELECT tokens FROM users WHERE id=$1`, [req.user.id]);
  const tk = bal.rows[0].tokens || 0;
  if (tk < cost)
    return res.status(400).json({ error: 'token ไม่เพียงพอ' });

  await query(`UPDATE users SET tokens=tokens-$1 WHERE id=$2`,[cost,req.user.id]);
  await query(`UPDATE posts SET promoted=true, promoted_at=NOW() WHERE id=$1`,[id]);
  res.json({ok:true,tokens:tk-cost});
});
export default router;

// แก้ไขโพสต์ (อัปโหลดรูปใหม่ได้ ต้องล็อกอิน)
router.put('/:id', requireAuth, multerArray('images', 10), async (req,res)=>{
  const id = Number(req.params.id);
  const owner = await query(`SELECT user_id, status FROM posts WHERE id=$1`, [id]);
  if (!owner.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  if (owner.rows[0].user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  if (owner.rows[0].status === 'waiting')
    return res.status(400).json({ error: 'โพสต์กำลังรอการอนุมัติ; ไม่สามารถแก้ไขได้' });
  if (owner.rows[0].status === 'pending')
    return res.status(400).json({ error: 'โพสต์กำลังรอการอนุมัติ; ไม่สามารถแก้ไขได้' });
  // อนุญาตให้แก้ไขโพสต์ที่ approved แล้ว

  const { title, description } = req.body;
  const isSell = (typeof req.body.is_sell !== 'undefined') ? ['true','on','1','yes'].includes(String(req.body.is_sell).toLowerCase()) : null;
  const isTrade = (typeof req.body.is_trade !== 'undefined') ? ['true','on','1','yes'].includes(String(req.body.is_trade).toLowerCase()) : null;
  const price = (req.body.price !== undefined && req.body.price !== '') ? Number(req.body.price) : null;
  const raw = req.body.tags;
  let tags = null;
  if (raw !== undefined) {
    tags = Array.isArray(raw) ? raw.flatMap(v=>String(v).split(',')).map(s=>s.trim()).filter(Boolean)
                              : (typeof raw === 'string' ? raw.split(',').map(s=>s.trim()).filter(Boolean) : []);
  }
  const rawSpecial = req.body.special_tags;
  let special_tags = null;
  if (rawSpecial !== undefined) {
    special_tags = Array.isArray(rawSpecial) ? rawSpecial.flatMap(v=>String(v).split(',')).map(s=>s.trim()).filter(Boolean)
                                            : (typeof rawSpecial === 'string' ? rawSpecial.split(',').map(s=>s.trim()).filter(Boolean) : []);
  }
  const images = (req.files && req.files.length) ? req.files.map(f=>('/uploads/posts/'+f.filename)) : null;
  // if new images uploaded, enforce 4-10 rule
  if (req.files && req.files.length) {
    const cnt = req.files.length;
    if (cnt < 4 || cnt > 10)
      return res.status(400).json({ error: 'เมื่อทำการแทนที่รูปภาพ ให้ทำการอัปโหลดระหว่าง 4 ถึง 10 ไฟล์' });
  }

  const sets = []; const ps = [id];
  function push(col, val){ ps.push(val); sets.push(col+'=$'+ps.length); }
  if (title !== undefined)
    push('title', title);
  if (description !== undefined)
    push('description', description);
  if (isSell !== null)
    push('is_sell', isSell);
  if (isTrade !== null)
    push('is_trade', isTrade);
  if (price !== null || req.body.price === '')
    push('price', price);
  if (tags !== null)
    push('tags', tags);
  if (special_tags !== null)
    push('special_tags', special_tags);
  if (images)
    push('image_url', JSON.stringify(images));
  
  // ถ้าโพสต์เดิมเป็น approved ให้คงสถานะเดิม
  const newStatus = owner.rows[0].status === 'approved' ? 'approved' : 'pending';
  push('status', newStatus);
  
  if (!sets.length)
    return res.status(400).json({ error: 'ไม่มีการเปลี่ยนแปลง' });
  const r = await query(`UPDATE posts SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, ps);
  res.json(r.rows[0]);
});

// ลบโพสต์ (ต้องล็อกอิน)
router.delete('/:id', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const owner = await query(`SELECT user_id FROM posts WHERE id=$1`, [id]);
  if (!owner.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  if (owner.rows[0].user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  await query(`DELETE FROM posts WHERE id=$1`, [id]);
  res.json({ok:true});
});

// ส่งโพสต์ที่ถูกปฏิเสธใหม่ (resubmit) (ต้องล็อกอิน)
router.post('/:id/resubmit', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const r = await query(`SELECT user_id,status FROM posts WHERE id=$1`, [id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  const row = r.rows[0];
  if (row.user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (row.status !== 'rejected')
    return res.status(400).json({ error: 'มีเพียงโพสต์ที่ถูกปฏิเสธเท่านั้นที่สามารถส่งใหม่ได้' });
  await query(`UPDATE posts SET status='pending' WHERE id=$1`, [id]);
  res.json({ok:true});
});