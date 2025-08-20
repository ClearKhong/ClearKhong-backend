import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router=Router();
router.get('/:postId', async (req,res)=>{
  const r=await query(`SELECT c.id,c.body,c.created_at,u.username FROM comments c JOIN users u ON u.id=c.user_id WHERE c.post_id=$1 ORDER BY c.id DESC`,[req.params.postId]);
  res.json(r.rows);
});
router.post('/:postId', requireAuth, async (req,res)=>{
  const body = (req.body.body || '').trim();
  if (!body)
    return res.status(400).json({ error: 'Empty' });
  const st = await query(`SELECT status FROM posts WHERE id=$1`, [req.params.postId]);
  if (!st.rowCount)
    return res.status(404).json({ error: 'post not found' });
  if (st.rows[0].status === 'pending' || st.rows[0].status === 'waiting')
    return res.status(400).json({ error: 'Comments are disabled for this post status' });
  await query(`INSERT INTO comments (post_id,user_id,body) VALUES ($1,$2,$3)`,[req.params.postId,req.user.id,body]);
  res.json({ok:true});
});
export default router;