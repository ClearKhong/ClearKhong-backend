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

// router.get('/', async (req, res) => {
//   const { q, tag } = req.query;
//   let sql = `SELECT p.*,u.username FROM posts p JOIN users u ON u.id=p.user_id WHERE status='approved'`;
//   const ps = [];
//   if (q)
//     { ps.push('%' + q + '%'); sql += ` AND LOWER(p.title) LIKE LOWER($${ps.length})`; }
//   if (tag) {
//     ps.push(tag);
//     sql += ` AND $${ps.length} = ANY(p.tags)`;
//   } sql += ' ORDER BY (p.promoted_at IS NOT NULL) DESC, p.promoted_at DESC NULLS LAST, p.created_at DESC LIMIT 100';
//   const r=await query(sql,ps); res.json(r.rows); });

// router.get('/:id', async (req,res)=>{ const r=await query(`SELECT p.*, u.id AS author_id, u.username AS author_username, u.profile_image_url AS author_profile_image_url FROM posts p JOIN users u ON u.id=p.user_id WHERE p.id=$1`,[req.params.id]);
//   if (!r.rowCount)
//     return res.status(404).json({ error: 'not found' }); res.json(r.rows[0]);
// });

router.get('/myfavoite', requireAuth, async (req, res) => {
  const user_id = req.user.id;
  const r = await query(
    `SELECT f.*, p.* 
     FROM favorites f 
     JOIN posts p ON p.id = f.post_id
     WHERE f.user_id=$1`,
    [user_id]
  );
  res.json(r.rows);
});

// router.post('/', async (req, res) => {
//   const { user_id, post_id } = req.body;
//   if (!post_id) return res.status(400).json({ error: 'post_id is required' });

//   // 1. เช็คว่ามี favorite อยู่แล้วหรือยัง
//   const existing = await query(
//     `SELECT 1 FROM favorites WHERE user_id=$1 AND post_id=$2`,
//     [user_id, post_id]
//   );

//   if (existing.rowCount) {
//     // 2. ถ้ามีแล้ว → ลบออก
//     await query(`DELETE FROM favorites WHERE user_id=$1 AND post_id=$2`, [user_id, post_id]);
//     return res.json({ ok: true, action: 'removed' });
//   } else {
//     // 3. ถ้ายังไม่มี → เพิ่มใหม่
//     await query(`INSERT INTO favorites (user_id, post_id) VALUES ($1, $2)`, [user_id, post_id]);
//     return res.json({ ok: true, action: 'added' });
//   }
// });

router.post('/togglefavorite', requireAuth, async (req, res) => {
  const { post_id } = req.body;
  if (!post_id) return res.status(400).json({ error: 'post_id is required' });

  // ✅ ดึง user_id จาก token ที่ผ่าน requireAuth
  const user_id = req.user.id;

  const existing = await query(
    `SELECT 1 FROM favorites WHERE user_id=$1 AND post_id=$2`,
    [user_id, post_id]
  );

  if (existing.rowCount) {
    await query(
      `DELETE FROM favorites WHERE user_id=$1 AND post_id=$2`,
      [user_id, post_id]
    );
    return res.json({ ok: true, action: 'removed' });
  } else {
    await query(
      `INSERT INTO favorites (user_id, post_id) VALUES ($1, $2)`,
      [user_id, post_id]
    );
    return res.json({ ok: true, action: 'added' });
  }
});



export default router;

