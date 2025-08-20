import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
const router=Router();
const tradeDir = path.join(process.cwd(), 'uploads', 'trades');
if (!fs.existsSync(tradeDir))
  fs.mkdirSync(tradeDir, { recursive: true });
const storage=multer.diskStorage({destination:(r,f,cb)=>cb(null,tradeDir),filename:(r,f,cb)=>cb(null,Date.now()+'-'+Math.round(Math.random()*1e9)+path.extname(f.originalname))});
const upload=multer({storage});

router.get('/:postId', requireAuth, async (req,res)=>{
  const pid=Number(req.params.postId);
  const post = await query('SELECT user_id FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount)
    return res.status(404).json({ error: 'not found' });
  const isOwner = post.rows[0].user_id===req.user.id;
  let sql=`SELECT t.*, u.username FROM trades t JOIN users u ON u.id=t.proposer_id WHERE post_id=$1`;
  let params=[pid];
  if (!isOwner) {
    sql += ' AND proposer_id=$2';
    params.push(req.user.id);
  }
  sql+=' ORDER BY id DESC';
  const r=await query(sql, params);
  res.json({offers:r.rows, isOwner});
});

router.post('/:postId', requireAuth, upload.array('images', 6), async (req,res)=>{
  const pid=Number(req.params.postId);
  const post = await query('SELECT user_id, status FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount)
    return res.status(404).json({ error: 'not found' });
  if (post.rows[0].status !== 'approved')
    return res.status(400).json({ error: 'The post is not ready for trading yet.' });
  const desc = req.body.description || '';
  const imgs = (req.files && req.files.length) ? req.files.map(f=>('/uploads/trades/'+f.filename)) : [];
  const img = JSON.stringify(imgs)
  const r=await query(`INSERT INTO trades (post_id,proposer_id,description,image_url,status) VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
    [pid, req.user.id, desc, img]);
  // แจ้งเตือนผู้ขาย
  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2)`,[post.rows[0].user_id,'New offer for trading']);
  res.json({ok:true, id:r.rows[0].id});
});

router.post('/:postId/accept/:offerId', requireAuth, async (req,res)=>{
  const pid = Number(req.params.postId);
  const oid = Number(req.params.offerId);
  const post = await query('SELECT user_id FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount)
    return res.status(404).json({ error: 'not found' });
  if (post.rows[0].user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  await query('UPDATE trades SET status=$1 WHERE id=$2 AND post_id=$3',['accepted',oid,pid]);
  await query('UPDATE posts SET status=$1 WHERE id=$2',['closed',pid]);
  // แจ้งเตือนผู้เทรดทั้งคู่
  const offer=await query('SELECT proposer_id FROM trades WHERE id=$1',[oid]);
  if(offer.rowCount){
    const proposer=offer.rows[0].proposer_id;
    await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2),($3,$4)`,
      [proposer,'Your trade offer has been confirmed.', req.user.id, 'You have successfully confirmed the trade.']);
  }
  res.json({ok:true});
});
export default router;