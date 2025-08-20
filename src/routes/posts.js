import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router=Router();
const postDir=path.join(process.cwd(),'uploads','posts'); if(!fs.existsSync(postDir)) fs.mkdirSync(postDir,{recursive:true});
const storage=multer.diskStorage({destination:(r,f,cb)=>cb(null,postDir),filename:(r,f,cb)=>cb(null,Date.now()+'-'+Math.round(Math.random()*1e9)+path.extname(f.originalname))});
const upload=multer({storage});
const DEFAULT_IMG='https://www.apple.com/v/iphone/home/cc/images/overview/consider_modals/environment/modal_trade_in_variant__ejij0q8th06e_large.jpg';

router.get('/', async (req, res) => {
  const { q, tag } = req.query;
  let sql = `SELECT p.*,u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE status='approved'`;
  const ps = [];
  if (q)
    { ps.push('%' + q + '%'); sql += ` AND LOWER(p.title) LIKE LOWER($${ps.length})`; }
  if (tag) {
    ps.push(tag);
    sql += ` AND $${ps.length} = ANY(p.tags)`;
  } sql += ' ORDER BY promoted DESC, id DESC LIMIT 100';
  const r=await query(sql,ps); res.json(r.rows); });

router.get('/:id', async (req,res)=>{ const r=await query(`SELECT p.*, u.id AS author_id, u.username AS author_username, u.profile_image_url AS author_profile_image_url FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1`,[req.params.id]);
  if (!r.rowCount)
    return res.status(404).json({ error: 'not found' }); res.json(r.rows[0]);
});

router.post('/', requireAuth, upload.array('images', 8), async (req,res)=>{
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
  const images = (req.files && req.files.length) ? req.files.map(f=>('/uploads/posts/'+f.filename)) : [DEFAULT_IMG];
  const image = JSON.stringify(images)
  if (!title || !description || (!isSell && !isTrade))
    return res.status(400).json({ error: 'Incomplete information' });
  if (isSell && (price === null || Number.isNaN(price)))
    return res.status(400).json({ error: 'Must have price' });
  const r=await query(`INSERT INTO posts (user_id,title,description,price,is_sell,is_trade,tags,image_url,status,promoted) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'pending',false) RETURNING id`,
   [req.user.id,title,description,price,isSell,isTrade,tags,image]);
  res.json({ok:true,postId:r.rows[0].id}); });

router.post('/:id/confirm', requireAuth, async (req,res)=>{
  const pid=Number(req.params.id);
  // ห้ามซื้อของโพสต์ตัวเอง
  const owner = await query('SELECT user_id, price FROM posts WHERE id=$1 AND status=$2', [pid, 'approved']);
  if (!owner.rowCount)
    return res.status(400).json({ error: 'Cannot confirm' });
  if (owner.rows[0].user_id === req.user.id)
    return res.status(400).json({ error: 'Cannot buy your own' });
  await query(`UPDATE posts SET status='closed' WHERE id=$1`,[pid]);
  const price=owner.rows[0].price||0;
  await query(`INSERT INTO purchases (post_id,buyer_id,amount,status) VALUES ($1,$2,$3,'paid')`,[pid,req.user.id,price]);
  // แจ้งเตือนผู้ขายและผู้ซื้อ
  const seller=owner.rows[0].user_id;
  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2),($3,$4)`,[seller,'Your product has been successfully purchased.',req.user.id,'Payment complete']);
  res.json({ok:true});
});

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
  await query(`UPDATE posts SET promoted=true WHERE id=$1`,[id]);
  res.json({ok:true,tokens:tk-cost});
});
export default router;
//แก้โพสต์
router.put('/:id', requireAuth, upload.array('images', 8), async (req,res)=>{
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

  const sets = []; const ps = [id];
  function push(col, val){ ps.push(val); sets.push(col+'=$'+ps.length); }
  if(title!==undefined) push('title', title);
  if(description!==undefined) push('description', description);
  if(isSell!==null) push('is_sell', isSell);
  if(isTrade!==null) push('is_trade', isTrade);
  if(price!==null || req.body.price==='') push('price', price);
  if(tags!==null) push('tags', tags);
  if(images) push('image_url', JSON.stringify(images));
  //แก้เสร็จ->pending
  push('status', 'pending');
  if (!sets.length)
    return res.status(400).json({ error: 'No changes' });
  const r = await query(`UPDATE posts SET ${sets.join(', ')} WHERE id=$1 RETURNING *`, ps);
  res.json(r.rows[0]);
});

//ลบโพสต์
router.delete('/:id', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const owner = await query(`SELECT user_id, status FROM posts WHERE id=$1`, [id]);
  if (!owner.rowCount)
    return res.status(404).json({ error: 'not found' });
  if (owner.rows[0].user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (owner.rows[0].status === 'approved')
    return res.status(400).json({ error: 'Cannot delete published post' });
  await query(`DELETE FROM posts WHERE id=$1`, [id]);
  res.json({ok:true});
});

//ยืนยันโพสต์
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

//ส่งใหม่
router.post('/:id/resubmit', requireAuth, async (req,res)=>{
  const id = Number(req.params.id);
  const r = await query(`SELECT user_id,status FROM posts WHERE id=$1`, [id]);
  if(!r.rowCount) return res.status(404).json({error:'not found'});
  const row = r.rows[0];
  if (row.user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (row.status !== 'rejected')
    return res.status(400).json({ error: 'Only rejected posts can be resubmitted' });
  await query(`UPDATE posts SET status='pending' WHERE id=$1`, [id]);
  res.json({ok:true});
});