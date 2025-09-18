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



router.post('/togglefavorite', requireAuth, async (req, res) => {
  const { post_id } = req.body;
  if (!post_id) return res.status(400).json({ error: 'post_id is required' });

  
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

