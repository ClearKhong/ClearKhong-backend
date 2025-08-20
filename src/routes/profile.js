import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router = Router();
const avatarDir = path.join(process.cwd(), 'uploads', 'avatars');
if (!fs.existsSync(avatarDir))
  fs.mkdirSync(avatarDir, { recursive: true });
const storage = multer.diskStorage({ destination: (r, f, cb) => cb(null, avatarDir), filename: (r, f, cb) => cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(f.originalname)) });
const upload = multer({ storage });

// โปรไฟล์สาธารณะ: อ่านโปรไฟล์ผู้ใช้คนอื่น + โพสต์ล่าสุด (ไม่ต้องล็อกอิน)
router.get('/public/:id', async (req, res) => {
  const uid = req.params.id;
  const u = await query(
    `SELECT id, username, shop_name, phone, email,bio, profile_image_url FROM users WHERE id=$1`,
    [uid]
  );
  if (!u.rowCount) return res.status(404).json({ error: 'user not found' });
  const posts = await query(
    `SELECT id, title, status, created_at
       FROM posts
      WHERE user_id=$1
      ORDER BY created_at DESC
      LIMIT 10`,
    [uid]
  );
  res.json({ user: u.rows[0], recentPosts: posts.rows });
});
router.get('/me', requireAuth, async (req, res) => {
  const r = await query(`SELECT id,username,shop_name,phone,email,address,bio,profile_image_url,tokens,role FROM users WHERE id=$1`, [req.user.id]);
  res.json(r.rows[0]);
});
//อัพเดตโปรไฟล์
router.put('/me', requireAuth, upload.single('profileImage'), async (req, res) => {
  const { shopName, phone, email, address, bio } = req.body;
  const phoneOk = !phone || /^\d{10}$/.test(String(phone));
  const emailOk = !email || String(email).includes('@');
  if (!phoneOk)
    return res.status(400).json({ error: 'Phone must be 10 digits' });
  if (!emailOk)
    return res.status(400).json({ error: 'Email must contain @' });
  const img = req.file ? ('/uploads/avatars/' + req.file.filename) : null;
  const r = await query(`UPDATE users 
    SET shop_name=COALESCE($2, shop_name), 
        phone=COALESCE($3, phone),
        email=COALESCE($4, email),
        address=COALESCE($5, address),
        bio=COALESCE($6, bio),
        profile_image_url=COALESCE($7, profile_image_url)
    WHERE id=$1
    RETURNING id,username,shop_name,phone,email,address,bio,profile_image_url,tokens,role`, 
    [req.user.id, shopName || null, phone || null, email || null, address || null, bio || null, img]);
  res.json(r.rows[0]);
});
//ประวัติ
router.get('/history', requireAuth, async (req,res)=>{ const myPosts=await query(`SELECT id,title,status,promoted,created_at FROM posts WHERE user_id=$1 ORDER BY created_at DESC`,[req.user.id]);
  const buys = await query(`SELECT pu.id,pu.post_id,pu.amount,pu.status,pu.created_at,p.title FROM purchases pu JOIN posts p ON p.id=pu.post_id WHERE pu.buyer_id=$1 ORDER BY pu.created_at DESC`, [req.user.id])
  const trades = await query(
    `SELECT t.id, t.post_id, t.status, t.created_at, COALESCE(p.title,'') AS title
       FROM trades t
       JOIN posts p ON p.id=t.post_id
      WHERE t.proposer_id=$1
      ORDER BY t.created_at DESC`,
    [req.user.id]
  );
  res.json({ myPosts: myPosts.rows, myBuys: buys.rows, myTrades: trades.rows });
});
export default router;