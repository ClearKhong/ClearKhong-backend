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

// แสดงข้อเสนอเทรดทั้งหมด
router.get('/my-trades',requireAuth ,async (req, res) => {
  const tradesRes = await query(
    'SELECT id, title, description, image_url, status FROM trades WHERE proposer_id=$1 AND status=$2 ORDER BY id DESC',
    [req.user.id, 'pending']
  );

  if (tradesRes.rows.length === 0) {
    return res.json({ trades: [] });
  }  

  const trades = tradesRes.rows.map(t => {
    let images = [];
    try {
      images = JSON.parse(t.image_url || '[]');
    } catch (e) {
      images = [];
    }
    return {
      id: t.id,
      title: t.title,
      description: t.description,
      images,
      status: t.status
    };
  });

  res.json({ trades });
});

// สร้างข้อเสนอการเทรดใหม่
router.post('/:postId/new', requireAuth, upload.array('images', 10), async (req,res)=>{
  const pid = Number(req.params.postId);

  const post = await query('SELECT user_id, status, is_trade FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount) return res.status(404).json({ error: 'not found' });
  if (post.rows[0].status !== 'approved') return res.status(400).json({ error: 'The post is not ready for trading yet.' });
  if (post.rows[0].user_id === req.user.id) return res.status(400).json({ error: 'cannot offer trade on your own post' });
  if (!post.rows[0].is_trade) return res.status(400).json({ error: 'this post does not accept trades' });

  const { title, description } = req.body;
  const imgs = (req.files && req.files.length) ? req.files.map(f => '/uploads/trades/' + f.filename) : [];
  const img = JSON.stringify(imgs);

  const r = await query(
    `INSERT INTO trades (proposer_id, title, description, image_url, status)
     VALUES ($1,$2,$3,$4,'pending') RETURNING id`,
    [req.user.id, title, description, img]
  );
  const tradeId = r.rows[0].id;

  await query(
    'INSERT INTO trade_posts (trade_id, post_id) VALUES ($1, $2)',
    [tradeId, pid]
  );

  // แจ้งเตือนผู้ขาย
  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2)`, [post.rows[0].user_id,'New offer for trading']);
  res.json({ok:true, id:tradeId});
});

// ใช้ข้อเสนอการเทรดเดิม
router.post('/:postId/reuse/:tradeId', requireAuth, async (req, res) => {
  const pid = Number(req.params.postId);
  const tradeId = Number(req.params.tradeId);

  const post = await query('SELECT user_id, status, is_trade FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount) return res.status(404).json({ error: 'not found' });
  if (post.rows[0].status !== 'approved') return res.status(400).json({ error: 'The post is not ready for trading yet.' });
  if (post.rows[0].user_id === req.user.id) return res.status(400).json({ error: 'cannot offer trade on your own post' });
  if (!post.rows[0].is_trade) return res.status(400).json({ error: 'this post does not accept trades' });

  if (!tradeId) return res.status(400).json({ error: 'No trade ID provided' });

  const tradeRes = await query(
    'SELECT id, proposer_id, status FROM trades WHERE id=$1',
    [tradeId]
  );

  if (!tradeRes.rowCount) return res.status(404).json({ error: 'Trade not found' });

  const trade = tradeRes.rows[0];
  if (trade.proposer_id !== req.user.id || trade.status !== 'pending') 
    return res.status(403).json({ error: 'You cannot use this trade' });

  const existing = await query(
    'SELECT 1 FROM trade_posts WHERE trade_id=$1 AND post_id=$2',
    [tradeId, pid]
  );
  if (existing.rowCount) return res.status(400).json({ error: 'You have already offered this trade to this post' });

  await query(
    'INSERT INTO trade_posts (trade_id, post_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [tradeId, pid]
  );

  // แจ้งเตือนผู้ขาย
  await query(
    'INSERT INTO notifications (user_id,message) VALUES ($1,$2)',
    [post.rows[0].user_id, 'New offer for trading']
  );
  res.json({ ok: true, tradeId });
});

// ดึงข้อเสนอการเทรดทั้งหมดของโพสต์
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
 
// ลบข้อเสนอการเทรดทั้งหมด (โดยผู้เสนอเทรด)
router.delete('/:tradeId', requireAuth, async (req, res) => {
  const tradeId = Number(req.params.tradeId);

  if (isNaN(tradeId)) {
    return res.status(400).json({ error: 'Invalid trade ID5' });
  }

  const tradeRes = await query('SELECT id, proposer_id FROM trades WHERE id=$1', [tradeId]);
  if (!tradeRes.rowCount) return res.status(404).json({ error: 'Trade not found' });

  const trade = tradeRes.rows[0];
  if (trade.proposer_id !== req.user.id) 
    return res.status(403).json({ error: 'You cannot delete this trade' });

  await query('DELETE FROM trades WHERE id=$1', [tradeId]);

  res.json({ ok: true, message: 'Trade deleted successfully' });
});

// เจ้าของโพสต์ยอมรับข้อเสนอการเทรด
router.post('/:postId/accept/:offerId', requireAuth, async (req,res)=>{
  const pid = Number(req.params.postId);
  const oid = Number(req.params.offerId);
  const post = await query('SELECT user_id, status, is_trade FROM posts WHERE id=$1', [pid]);
  if (!post.rowCount)
    return res.status(404).json({ error: 'not found' });
  if (post.rows[0].user_id !== req.user.id)
    return res.status(403).json({ error: 'forbidden' });
  if (post.rows[0].status !== 'approved' || !post.rows[0].is_trade)
    return res.status(400).json({ error: 'post is not tradable' });
  const offer=await query('SELECT proposer_id, status FROM trades WHERE id=$1 AND post_id=$2',[oid,pid]);
  if (!offer.rowCount)
    return res.status(404).json({ error: 'offer not found' });
  if (offer.rows[0].status !== 'pending')
    return res.status(400).json({ error: 'offer not pending' });
  await query('UPDATE trades SET status=$1 WHERE id=$2 AND post_id=$3',['accepted',oid,pid]);
  await query('UPDATE posts SET status=$1 WHERE id=$2',['closed',pid]);

  await query(`INSERT INTO notifications (user_id,message) VALUES ($1,$2),($3,$4)`,
    [offer.rows[0].proposer_id,'Your trade offer has been confirmed.', req.user.id, 'You have successfully confirmed the trade.']);
  res.json({ok:true});
});

export default router;