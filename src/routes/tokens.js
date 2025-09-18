import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router=Router();
router.post('/confirm', requireAuth, async (req,res)=>{ const amount=Number(req.body.amount||0);
  if (![5, 10, 20, 50, 100, 500].includes(amount))
    return res.status(400).json({ error: 'Incorrect package' });
  const r = await query(`SELECT tokens FROM users WHERE id=$1`, [req.user.id]);
  const cur = r.rows[0].tokens || 0;
  if (cur + amount > 1000)
    return res.status(400).json({ error: 'Max tokens 1000' });
  const r2=await query(`UPDATE users SET tokens=tokens+$1 WHERE id=$2 RETURNING tokens`,[amount,req.user.id]);
  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2)`,[req.user.id,`Buy ${amount} tokens successful`]);
  res.json({ok:true,tokens:r2.rows[0].tokens}); });
export default router;