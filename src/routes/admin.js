import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
const router = Router();
const avatarDir = path.join(process.cwd(), 'uploads', 'avatars');
if (!fs.existsSync(avatarDir))
  fs.mkdirSync(avatarDir, { recursive: true });
const storage = multer.diskStorage({ destination: (r,f,cb)=>cb(null, avatarDir), filename: (r,f,cb)=>cb(null, Date.now()+'-'+Math.round(Math.random()*1e9)+path.extname(f.originalname)) });
const upload = multer({ storage });
router.use(requireAuth, requireAdmin);
router.get('/pending', async (req, res) => {
  const r = await query(`SELECT p.id,p.title,u.username,p.status FROM posts p JOIN users u ON u.id=p.user_id WHERE p.status='pending' ORDER BY p.id DESC`);
  res.json(r.rows);
});
router.post('/posts/:id/approve', async (req,res)=>{ const r=await query(`UPDATE posts SET status='waiting' WHERE id=$1 RETURNING id, user_id`,[req.params.id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'not found' });
  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2)`,[r.rows[0].user_id,'Your post has been approved']);
  res.json({ok:true}); });
router.post('/posts/:id/reject', async (req,res)=>{ const r=await query(`UPDATE posts SET status='rejected' WHERE id=$1 RETURNING id, user_id`,[req.params.id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'not found' });
  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2)`,[r.rows[0].user_id,'Your post has been rejected']);
  res.json({ok:true}); });
router.get('/users', async (req, res) => {
  const r = await query(`SELECT id,username,role,is_active FROM users ORDER BY id ASC`);
  res.json(r.rows);
});
router.post('/users/:id/suspend', async (req, res) => {
  const u = await query('SELECT role FROM users WHERE id=$1', [req.params.id]);
  if (u.rows[0]?.role === 'admin')
    return res.status(400).json({ error: 'Unable to suspend admin account' });
  await query(`UPDATE users SET is_active=false WHERE id=$1`, [req.params.id]);
  await query(`DELETE FROM posts WHERE user_id=$1`, [req.params.id]); res.json({ ok: true, deleted: true });
});
router.post('/users/:id/activate', async (req, res) => {
  await query(`UPDATE users SET is_active=true WHERE id=$1`, [req.params.id]);
  res.json({ ok: true });
});
router.get('/posts', async (req, res) => {
  const r = await query(`SELECT p.id,p.title,p.status,u.username,u.id as user_id FROM posts p JOIN users u ON u.id=p.user_id ORDER BY p.id DESC`);
  res.json(r.rows);
});

// Reports
router.get('/reports', async (req,res)=>{
  const r = await query(
    `SELECT r.id, r.status, r.created_at, r.reasons,
            ur.username AS reporter, ut.username AS target
       FROM reports r
       JOIN users ur ON ur.id = r.reporter_id
       JOIN users ut ON ut.id = r.target_user_id
      ORDER BY r.id DESC`
  );
  res.json(r.rows);
});

router.get('/reports/:id', async (req,res)=>{
  const r = await query(
    `SELECT r.*, ur.username AS reporter, ut.username AS target
       FROM reports r
       JOIN users ur ON ur.id = r.reporter_id
       JOIN users ut ON ut.id = r.target_user_id
      WHERE r.id=$1`,
    [req.params.id]
  );
  if(!r.rowCount) return res.status(404).json({ error:'not found' });
  res.json(r.rows[0]);
});

router.post('/reports/:id/status', async (req,res)=>{
  const { status } = req.body; // open, reviewing, resolved
  await query(`UPDATE reports SET status=$1 WHERE id=$2`, [status||'open', req.params.id]);
  res.json({ ok:true });
});

export default router;

router.get('/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  const r = await query(`SELECT id, username, shop_name, phone, email, address, bio, profile_image_url, tokens, role, is_active FROM users WHERE id=$1`, [id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});

router.get('/users/:id/history', async (req, res) => {
  const id = Number(req.params.id);
  const myPosts = await query(`SELECT id,title,status,created_at FROM posts WHERE user_id=$1 ORDER BY created_at DESC`, [id]);
  const buys = await query(`SELECT pu.id,pu.post_id,pu.amount,pu.status,pu.created_at,p.title
                            FROM purchases pu LEFT JOIN posts p ON p.id=pu.post_id
                            WHERE pu.buyer_id=$1 ORDER BY pu.created_at DESC`, [id]);
  res.json({ myPosts: myPosts.rows, myBuys: buys.rows });
});

router.put('/users/:id', upload.single('profileImage'), async (req, res) => {
  const id = Number(req.params.id);
  const { shopName, phone, email } = req.body;
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
        profile_image_url=COALESCE($5, profile_image_url)
    WHERE id=$1
    RETURNING id,username,shop_name,phone,email,profile_image_url,tokens,role,is_active`, 
    [id, shopName || null, phone || null, email || null, img]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'not found' });
  res.json(r.rows[0]);
});