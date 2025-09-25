import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();



/**
 * GET /api/orders/trade/my
 * ดูใบ trade orders ของเรา (เป็น sender หรือ receiver ก็ได้)
 */
router.get('/my', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const r = await query(
      `SELECT o.*, p.title, p.image_url
       FROM trade_orders o
       JOIN posts p ON p.id = o.post_id
       WHERE o.sender_id=$1 OR o.receiver_id=$1
       ORDER BY o.created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * GET /api/orders/trade/:id
 * รายละเอียดใบ trade order detail ตาม id
 */
router.get('/:id', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const userId  = req.user.id;

  try {
    const r = await query(
      `SELECT o.*, p.title, p.image_url,
              su.username AS sender_name, ru.username AS receiver_name
       FROM trade_orders o
       JOIN posts  p  ON p.id = o.post_id
       JOIN users su ON su.id = o.sender_id
       JOIN users ru ON ru.id = o.receiver_id
       WHERE o.id=$1 AND (o.sender_id=$2 OR o.receiver_id=$2)`,
      [orderId, userId]
    );

    if (!r.rowCount) return res.status(404).json({ error: 'Order not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

// Proposer confirm trade → create 2 orders + close post
router.post('/trade/:tradeId/confirm', requireAuth, async (req, res) => {
  const tradeId = Number(req.params.tradeId);
  const userId = req.user.id;

  try {
    const t = await query(
      `SELECT id, proposer_id, title, description, image_url, status
       FROM trades WHERE id=$1`,
      [tradeId]
    );
    if (!t.rowCount) return res.status(404).json({ error: 'trade not found' });
    const trade = t.rows[0];

    if (trade.proposer_id !== userId)
      return res.status(403).json({ error: 'only proposer can confirm this trade' });
    if (trade.status !== 'accepted')
      return res.status(400).json({ error: 'trade not accepted yet' });

    // หาโพสต์ของ owner
    const tp = await query(
      `SELECT tp.post_id, p.user_id AS owner_id
       FROM trade_posts tp
       JOIN posts p ON p.id=tp.post_id
       WHERE tp.trade_id=$1 LIMIT 1`,
      [tradeId]
    );
    if (!tp.rowCount) return res.status(400).json({ error: 'owner post mapping not found' });
    const owner_post_id = tp.rows[0].post_id;
    const owner_id = tp.rows[0].owner_id;

    // ปิดโพสต์ owner
    await query(`UPDATE posts SET status='closed' WHERE id=$1`, [owner_post_id]);

    // ✅ Order ของ proposer → อิง post ของ owner
    const proposerOrder = await query(
      `INSERT INTO trade_orders (trade_id, post_id, sender_id, receiver_id, status)
       VALUES ($1,$2,$3,$4,'waiting_shipping')
       RETURNING id, status`,
      [tradeId, owner_post_id, trade.proposer_id, owner_id]
    );

    // ✅ Order ของ owner → อิงสิ่งที่ proposer เสนอ (offered_trade_id)
    const ownerOrder = await query(
      `INSERT INTO trade_orders (trade_id, offered_trade_id, sender_id, receiver_id, status)
       VALUES ($1,$2,$3,$4,'waiting_shipping')
       RETURNING id, status`,
      [tradeId, trade.id, owner_id, trade.proposer_id]
    );

    await query(`UPDATE trades SET status='confirmed' WHERE id=$1`, [tradeId]);

    // แจ้งเตือนทั้ง proposer และ owner
    await query(
      'INSERT INTO notifications (user_id, message) VALUES ($1,$2), ($3,$4)',
      [
        trade.proposer_id, 'Trade confirmed. Please prepare to ship your item.',
        owner_id,          'Trade confirmed. Please prepare to ship your item.'
      ]
    );

    res.json({
      ok: true,
      message: 'Trade confirmed, trade orders created',
      orders: { proposer_order: proposerOrder.rows[0], owner_order: ownerOrder.rows[0] }
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'server error' });
  }
});


/**
 * POST /api/orders/trade/:id/add-tracking
 * ผู้ส่ง (sender) ของใบนี้เท่านั้นที่ใส่เลขพัสดุได้
 * เปลี่ยน status -> shipping
 */
router.post('/trade/:id/trade-add-tracking', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const { tracking_number } = req.body;
  const userId = req.user.id;

  if (!tracking_number) {
    return res.status(400).json({ error: 'tracking_number is required' });
  }

  try {
    const r = await query(
      `UPDATE trade_orders
       SET tracking_number=$1, status='shipping', updated_at=NOW()
       WHERE id=$2 AND sender_id=$3 AND status='waiting_shipping'
       RETURNING id, status, tracking_number`,
      [tracking_number, orderId, userId]
    );

    if (!r.rowCount) {
      return res.status(400).json({ error: 'Order not found or invalid state' });
    }
    // แจ้งเตือนผู้รับ
    const receiverRes = await query('SELECT receiver_id FROM trade_orders WHERE id=$1', [orderId]);
    const receiverId = receiverRes.rows[0].receiver_id;
    await query(
      'INSERT INTO notifications (user_id, message) VALUES ($1,$2)',
      [receiverId, `Sender has shipped the item. Tracking: ${tracking_number}`]
    );
    
    res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * POST /api/orders/trade/:id/confirm-delivery
 * ผู้รับ (receiver) ของใบนี้เท่านั้นที่กดได้
 * เปลี่ยน status -> completed
 */
router.post('/trade/:id/trade-confirm-delivery', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user.id;

  try {
    const r = await query(
      `UPDATE trade_orders
       SET status='completed', updated_at=NOW()
       WHERE id=$1 AND receiver_id=$2 AND status IN ('shipping','waiting_shipping')
       RETURNING id, status`,
      [orderId, userId]
    );

    if (!r.rowCount) {
      return res.status(400).json({ error: 'Order not found or invalid state' });
    }

    const senderRes = await query('SELECT sender_id FROM trade_orders WHERE id=$1', [orderId]);
    const senderId = senderRes.rows[0].sender_id;

    // แจ้งเตือนผู้ส่ง
    await query(
      'INSERT INTO notifications (user_id, message) VALUES ($1,$2)',
      [senderId, 'Receiver confirmed delivery. Trade order completed.']
    );
    res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * GET /api/orders/trade/my
 * ดูใบ trade orders ของเรา (เป็น sender หรือ receiver ก็ได้)
 */
router.get('/trade/my', requireAuth, async (req, res) => {
  const userId = req.user.id;
  try {
    const r = await query(
      `SELECT o.*, p.title, p.image_url
       FROM trade_orders o
       JOIN posts p ON p.id = o.post_id
       WHERE o.sender_id=$1 OR o.receiver_id=$1
       ORDER BY o.created_at DESC`,
      [userId]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * GET /api/orders/trade/:id
 * รายละเอียดใบ trade order
 */
router.get('/trade/:id', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const userId  = req.user.id;

  try {
    const r = await query(
      `SELECT o.*, p.title, p.image_url,
              su.username AS sender_name, ru.username AS receiver_name
       FROM trade_orders o
       JOIN posts  p  ON p.id = o.post_id
       JOIN users su ON su.id = o.sender_id
       JOIN users ru ON ru.id = o.receiver_id
       WHERE o.id=$1 AND (o.sender_id=$2 OR o.receiver_id=$2)`,
      [orderId, userId]
    );

    if (!r.rowCount) return res.status(404).json({ error: 'Order not found' });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

export default router;
