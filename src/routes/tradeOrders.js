import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import multer from 'multer';
const textOnly = multer(); 
const router = Router();

// Proposer confirm trade → close post + create ONE order (owner -> proposer)
router.post('/trade/:tradeId/confirm', requireAuth, textOnly.none(), async (req, res) => {
  const tradeId = Number(req.params.tradeId);
  const userId = req.user.id;

  try {
    const t = await query('SELECT id, proposer_id, status FROM trades WHERE id=$1', [tradeId]);
    if (!t.rowCount) return res.status(404).json({ error: 'ไม่พบการเทรด' });

    const trade = t.rows[0];
    if (trade.proposer_id !== userId) return res.status(403).json({ error: 'เฉพาะผู้เสนอเท่านั้นที่สามารถยืนยันการเทรดนี้ได้' });
    if (trade.status !== 'accepted_waiting_confirm') return res.status(400).json({ error: 'การเทรดยังไม่ได้รับการยอมรับ' });

    const tp = await query(
      `SELECT tp.post_id, p.user_id AS owner_id
       FROM trade_posts tp
       JOIN posts p ON p.id=tp.post_id
       WHERE tp.trade_id=$1 LIMIT 1`,
      [tradeId]
    );
    if (!tp.rowCount) return res.status(400).json({ error: 'ไม่พบการแมพโพสต์ของเจ้าของ' });

    const owner_post_id = tp.rows[0].post_id;
    const owner_id = tp.rows[0].owner_id;

    let { name, phone, address } = req.body;
    // ดึงข้อมูลจาก users ถ้าไม่ได้ส่งมา
    if (!address || !name || !phone) {
      const user = await query(
        'SELECT address, name, phone FROM users WHERE id=$1',
        [userId]
      );
      if (user.rowCount) {
        if (!address) address = user.rows[0].address || null;
        if (!name) name = user.rows[0].name || null;
        if (!phone) phone = user.rows[0].phone || null;
      }
    }
    if (phone && !/^\d{10}$/.test(phone)) {
      return res.status(400).json({ error: 'หมายเลขโทรศัพท์ต้องมี 10 หลัก' });
    }
    if (!address) return res.status(400).json({ error: 'ต้องระบุที่อยู่ในการจัดส่ง' });

    await query('BEGIN');

    await query(`UPDATE posts SET status='closed' WHERE id=$1 AND status<>'closed'`, [owner_post_id]);

    const existsOwnerOrder = await query(
      `SELECT id FROM trade_orders WHERE trade_id=$1 AND post_id=$2 AND sender_id=$3 AND receiver_id=$4`,
      [tradeId, owner_post_id, owner_id, trade.proposer_id]
    );

    let ownerOrderId;
    if (existsOwnerOrder.rowCount) {
      const upd = await query(
        `UPDATE trade_orders
         SET name=$1, phone=$2, address=$3, status='waiting_shipping', updated_at=NOW()
         WHERE id=$4 RETURNING id`,
        [name, phone, address, existsOwnerOrder.rows[0].id]
      );
      ownerOrderId = upd.rows[0].id;
    } else {
      const ins = await query(
        `INSERT INTO trade_orders
         (trade_id, post_id, sender_id, receiver_id, status, name, phone, address)
         VALUES ($1,$2,$3,$4,'waiting_shipping',$5,$6,$7)
         RETURNING id`,
        [tradeId, owner_post_id, owner_id, trade.proposer_id, name, phone, address]
      );
      ownerOrderId = ins.rows[0].id;
    }

    await query(`UPDATE trades SET status='confirmed' WHERE id=$1 AND status='accepted_waiting_confirm'`, [tradeId]);

    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
       VALUES ($1,$2,$3,$4), ($4,$5,$3,$1)`,
      [owner_id, 'Trade confirmed. Please prepare to send your item.', owner_post_id, trade.proposer_id, 'การเทรดยืนยันแล้ว กรุณาเตรียมส่งสินค้า']
    );

    await query('COMMIT');

    res.json({ ok: true, message: 'Trade confirmed. Owner-to-proposer shipment created.', ownerOrderId });
  } catch (e) {
    console.error(e);
    await query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * POST /api/orders/trade/:id/add-tracking
 * ผู้ส่ง (sender) ของใบนี้เท่านั้นที่ใส่เลขพัสดุได้
 * เปลี่ยน status -> shipping
 */
router.post('/trade/:id/trade-add-tracking', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  const { tracking_number } = req.body;
  const userId = req.user.id;

  if (!tracking_number) return res.status(400).json({ error: 'ต้องระบุ tracking number' });

  try {
    const r = await query(
      `UPDATE trade_orders
       SET tracking_number=$1, status='shipping', updated_at=NOW()
       WHERE id=$2 AND sender_id=$3 AND status='waiting_shipping'
       RETURNING id,status,tracking_number,receiver_id,post_id`,
      [tracking_number, orderId, userId]
    );
    if (!r.rowCount) return res.status(400).json({ error: 'ไม่พบคำสั่งซื้อหรือสถานะไม่ถูกต้อง' });

    await query(
      `INSERT INTO notifications (user_id,message,post_id,actor_id)
       VALUES ($1,$2,$3,$4)`,
      [r.rows[0].receiver_id, `สินค้าของคุณได้ถูกจัดส่งแล้ว, tracking number: ${tracking_number}`, r.rows[0].post_id, userId]
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
  const orderId = Number(req.params.id);
  const userId = req.user.id;

  try {
    const r = await query(
      `UPDATE trade_orders
       SET status='completed', updated_at=NOW()
       WHERE id=$1 AND receiver_id=$2 AND status IN ('shipping','waiting_shipping')
       RETURNING id,status,sender_id,post_id`,
      [orderId, userId]
    );
    if (!r.rowCount) return res.status(400).json({ error: 'ไม่พบคำสั่งซื้อหรือสถานะไม่ถูกต้อง' });

    await query(
      `INSERT INTO notifications (user_id,message,post_id,actor_id)
       VALUES ($1,$2,$3,$4)`,
      [r.rows[0].sender_id, 'ผู้รับยืนยันการจัดส่ง สถานะการเทรดเสร็จสมบูรณ์', r.rows[0].post_id, userId]
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
      `SELECT o.id AS order_id,o.trade_id,o.sender_id,o.receiver_id,o.status,o.created_at,
        COALESCE(
          (SELECT json_agg(json_build_object('post_id',tp.post_id,'post_title',p.title))
           FROM trade_posts tp JOIN posts p ON p.id=tp.post_id WHERE tp.trade_id=o.trade_id),
          '[]'::json
        ) AS posts,
        COALESCE(
          (SELECT json_agg(json_build_object('title',ti.title,'description',ti.description,'tags',ti.tags,'images',COALESCE(NULLIF(ti.image_url,'')::json,'[]'::json)))
           FROM trade_items ti WHERE ti.trade_id=o.trade_id),
          '[]'::json
        ) AS items
       FROM trade_orders o
       WHERE o.sender_id=$1 OR o.receiver_id=$1
       ORDER BY o.created_at DESC`,
      [userId]
    );

    const as_sender = [];
    const as_receiver = [];
    for (const row of r.rows) {
      const base = { trade_id: row.trade_id, status: row.status, created_at: row.created_at, posts: row.posts ?? [], items: row.items ?? [] };
      if (row.sender_id === userId) as_sender.push(base); else as_receiver.push(base);
    }

    res.json({ myTrades: { as_sender, as_receiver } });
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
  const orderId = Number(req.params.id);
  const userId = req.user.id;

  try {
    const r = await query(
      `SELECT o.id AS order_id,o.trade_id,o.sender_id,o.receiver_id,o.status,o.created_at,
        su.username AS sender_name,ru.username AS receiver_name,
        COALESCE(
          (SELECT json_agg(json_build_object('post_id',tp.post_id,'post_title',p.title))
           FROM trade_posts tp JOIN posts p ON p.id=tp.post_id WHERE tp.trade_id=o.trade_id),
          '[]'::json
        ) AS posts,
        COALESCE(
          (SELECT json_agg(json_build_object('title',ti.title,'description',ti.description,'tags',ti.tags,'images',COALESCE(NULLIF(ti.image_url,'')::json,'[]'::json)))
           FROM trade_items ti WHERE ti.trade_id=o.trade_id),
          '[]'::json
        ) AS items
       FROM trade_orders o
       JOIN users su ON su.id=o.sender_id
       JOIN users ru ON ru.id=o.receiver_id
       WHERE o.id=$1 AND (o.sender_id=$2 OR o.receiver_id=$2)`,
      [orderId, userId]
    );

    if (!r.rowCount) return res.status(404).json({ error: 'Order not found' });

    const row = r.rows[0];
    res.json({ order_id: row.order_id, trade_id: row.trade_id, status: row.status, created_at: row.created_at, sender_name: row.sender_name, receiver_name: row.receiver_name, posts: row.posts ?? [], items: row.items ?? [] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

export default router;
//alice 2 offer diana 5 post 4 terade 1