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
const DEFAULT_IMG='https://www.apple.com/v/iphone/home/cc/images/overview/consider_modals/environment/modal_trade_in_variant__ejij0q8th06e_large.jpg';

const slipDir = path.join(process.cwd(), 'uploads', 'slips');
if (!fs.existsSync(slipDir)) fs.mkdirSync(slipDir, { recursive: true });

const slipStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, slipDir),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname))
});

const uploadSlip = multer({ storage: slipStorage });

// ดึงโพสต์ทั้งหมด (ค้นหา/กรองได้)
router.get('/', async (req, res) => {
  const { q, tag } = req.query;
  let sql = `SELECT p.*,u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE status='approved'`;
  const ps = [];
  if (q)
    { ps.push('%' + q + '%'); sql += ` AND LOWER(p.title) LIKE LOWER($${ps.length})`; }
  if (tag) {
    ps.push(tag);
    sql += ` AND $${ps.length} = ANY(p.tags)`;
  } sql += ' ORDER BY (p.promoted_at IS NOT NULL) DESC, p.promoted_at DESC NULLS LAST, p.created_at DESC';
  const r=await query(sql,ps); res.json(r.rows); });

// ดึงรายละเอียดโพสต์ตาม id
router.get('/:id', async (req,res)=>{ const r=await query(`SELECT p.*, u.id AS author_id, u.username AS author_username, u.profile_image_url AS author_profile_image_url FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1`,[req.params.id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'not found' }); res.json(r.rows[0]);
});

// สร้างโพสต์ใหม่ (อัปโหลดรูปได้ ต้องล็อกอิน)
router.post('/', requireAuth, upload.array('images', 10), async (req,res)=>{
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
  // enforce 4-10 uploaded images
  const uploaded = req.files || [];
  if (!uploaded.length)
    return res.status(400).json({ error: 'You must upload between 4 and 10 images' });
  if (uploaded.length < 4 || uploaded.length > 10)
    return res.status(400).json({ error: 'Images must be between 4 and 10 files' });
  const images = uploaded.map(f => ('/uploads/posts/'+f.filename));
  const image = JSON.stringify(images)
  if (!title || !description || (!isSell && !isTrade))
    return res.status(400).json({ error: 'Incomplete information' });
  if (isSell && (price === null || Number.isNaN(price) || price <= 0))
    return res.status(400).json({ error: 'Price must be a positive number' });
  const r=await query(`INSERT INTO posts (user_id,title,description,price,is_sell,is_trade,tags,image_url,status,promoted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',false) RETURNING id`,
   [req.user.id,title,description,price,isSell,isTrade,tags,image]);
  res.json({ok:true,postId:r.rows[0].id}); });

// ซื้อสินค้า (ต้องล็อกอิน)
router.post('/:id/buy', requireAuth, uploadSlip.single('payment_slip_url'), async (req, res) => {
  const post_id = Number(req.params.id);
  const buyer_id = req.user.id;
  let { address } = req.body;

  if (!post_id) return res.status(400).json({ error: 'postId is required' });

  if (!req.file) return res.status(400).json({ error: 'Payment slip is required (1 file)' });

  const uploadPath = '/uploads/slips/' + req.file.filename; 

  // ถ้า address ไม่มี ให้ดึงจาก user
  if (!address) {
    const user = await query('SELECT address FROM users WHERE id=$1', [buyer_id]);
    address = user.rowCount && user.rows[0].address ? user.rows[0].address : null;
  }

  const postRes = await query('SELECT user_id, price, status FROM posts WHERE id=$1', [post_id]);
  if (!postRes.rowCount) return res.status(404).json({ error: 'Post not found' });

  const seller_id = postRes.rows[0].user_id;
  const amount = postRes.rows[0].price || 0;

  if (seller_id === buyer_id) return res.status(400).json({ error: 'Cannot buy your own post' });
  if (postRes.rows[0].status !== 'approved') return res.status(400).json({ error: 'Cannot buy this post' });

  // ตรวจสอบ order ซ้ำ
  const existing = await query('SELECT 1 FROM orders WHERE post_id=$1 AND buyer_id=$2', [post_id, buyer_id]);
  if (existing.rowCount) return res.status(400).json({ error: 'Order already exists' });

  const orderRes = await query(
    `INSERT INTO orders (post_id, buyer_id, seller_id, status, address, payment_slip_url, amount)
     VALUES ($1,$2,$3,'waiting_confirm',$4,$5,$6) RETURNING *`,
    [post_id, buyer_id, seller_id, address, uploadPath, amount]
  );

  // แจ้งเตือนผู้ขาย
  await query('INSERT INTO notifications (user_id, message) VALUES ($1,$2)',
    [seller_id, 'New purchase order waiting for confirmation. Please check the payment slip.']);

  res.json({ ok: true, order: orderRes.rows[0] });
});


// โปรโมทโพสต์ (ต้องล็อกอิน)
router.post('/:id/promote', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const cost = 20;
  const post = await query(`SELECT user_id,status,promoted FROM posts WHERE id=$1`, [id]);
  if (!post.rowCount)
    return res.status(404).json({ error: 'Not found' });
  const p = post.rows[0];
  if (p.user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  if (p.status !== 'approved')
    return res.status(400).json({ error: 'Post must be approved before promoting' });
  if (p.promoted)
    return res.status(400).json({ error: 'Already promoted' });

  const bal = await query(`SELECT tokens FROM users WHERE id=$1`, [req.user.id]);
  const tk = bal.rows[0].tokens || 0;
  if (tk < cost)
    return res.status(400).json({ error: 'Not enough tokens' });

  await query(`UPDATE users SET tokens=tokens-$1 WHERE id=$2`,[cost,req.user.id]);
  await query(`UPDATE posts SET promoted=true, promoted_at=NOW() WHERE id=$1`,[id]);
  res.json({ok:true,tokens:tk-cost});
});
export default router;

// แก้ไขโพสต์ (อัปโหลดรูปใหม่ได้ ต้องล็อกอิน)
router.put('/:id', requireAuth, upload.array('images', 10), async (req,res)=>{
  const id = Number(req.params.id);
  const owner = await query(`SELECT user_id, status FROM posts WHERE id=$1`, [id]);
  if (!owner.rowCount)
    return res.status(404).json({ error: 'Not found' });
  if (owner.rows[0].user_id !== req.user.id)
    return res.status(403).json({ error: 'Forbidden' });
  if (owner.rows[0].status === 'waiting')
    return res.status(400).json({ error: 'Post is waiting; cannot edit' });
  if (owner.rows[0].status === 'pending')
    return res.status(400).json({ error: 'Post is pending; cannot edit' });
  if (owner.rows[0].status === 'approved')
    return res.status(400).json({ error: 'Already published' });

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
  const images = (req.files && req.files.length) ? req.files.map(f=>('/uploads/posts/'+f.filename)) : null;
  // if new images uploaded, enforce 4-10 rule
  if (req.files && req.files.length) {
    const cnt = req.files.length;
    if (cnt < 4 || cnt > 10)
      return res.status(400).json({ error: 'When replacing images, upload between 4 and 10 files' });
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
  if (images)
    push('image_url', JSON.stringify(images));
  //แก้เสร็จ->pending
  push('status', 'pending');
  if (!sets.length)
    return res.status(400).json({ error: 'No changes' });
  const r = await query(`UPDATE posts SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, ps);
  res.json(r.rows[0]);
});

// ลบโพสต์ (ต้องล็อกอิน)
router.delete('/:id', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const owner = await query(`SELECT user_id FROM posts WHERE id=$1`, [id]);
  if (!owner.rowCount)
    return res.status(404).json({ error: 'not found' });
  if (owner.rows[0].user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  await query(`DELETE FROM posts WHERE id=$1`, [id]);
  res.json({ok:true});
});

// ยืนยันโพสต์ (publish) หลังรออนุมัติ (ต้องล็อกอิน)
router.post('/:id/publish', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const r = await query(`SELECT user_id,status FROM posts WHERE id=$1`, [id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'not found' });
  const row = r.rows[0];
  if (row.user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (row.status !== 'waiting')
    return res.status(400).json({ error: 'Post must be waiting' });
  const cost = 10;
  const u = await query(`SELECT tokens FROM users WHERE id=$1`, [req.user.id]);
  const tk = u.rows[0]?.tokens || 0;
  if (tk < cost)
    return res.status(400).json({ error: 'Not enough tokens' });
  await query(`UPDATE users SET tokens=tokens-$1 WHERE id=$2`, [cost, req.user.id]);
  await query(`UPDATE posts SET status='approved' WHERE id=$1`, [id]);
  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2)`, [req.user.id, 'Your post is now published']);
  res.json({ok:true, tokens: tk - cost});
});

// ส่งโพสต์ที่ถูกปฏิเสธใหม่ (resubmit) (ต้องล็อกอิน)
router.post('/:id/resubmit', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const r = await query(`SELECT user_id,status FROM posts WHERE id=$1`, [id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'not found' });
  const row = r.rows[0];
  if (row.user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (row.status !== 'rejected')
    return res.status(400).json({ error: 'Only rejected posts can be resubmitted' });
  await query(`UPDATE posts SET status='pending' WHERE id=$1`, [id]);
  res.json({ok:true});
});