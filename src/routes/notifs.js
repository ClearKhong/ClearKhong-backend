import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router=Router();
router.get('/', requireAuth, async (req,res)=>{
  const r=await query(`SELECT id,message,created_at,read FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100`,[req.user.id]);
  res.json(r.rows);
});
router.post('/:id/read', requireAuth, async (req,res)=>{
  await query(`UPDATE notifications SET read=true WHERE id=$1 AND user_id=$2`,[req.params.id, req.user.id]);
  res.json({ok:true});
});
export default router;