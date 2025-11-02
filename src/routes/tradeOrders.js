import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import multer from 'multer';
const textOnly = multer(); 
const router = Router();
/**
 * GET /api/orders/trade/by-post/:postId
 * หา trade_order จาก post_id (สำหรับกรณีที่ owner เลือกข้อเสนอแล้ว)
 */
router.get('/trade/by-post/:postId', requireAuth, async (req, res) => {
  const postId = Number(req.params.postId);
  const userId = req.user.id;

  console.log(`🔍 GET /trade/by-post/${postId} - userId=${userId}`);

  try {
    // หา trade_order ที่เกี่ยวข้องกับ post_id นี้
    const r = await query(
      `
      SELECT 
        o.id AS order_id,
        o.trade_id,
        o.sender_id,
        o.receiver_id,
        o.status,
        o.created_at,
        o.tracking_number,
        o.shipping_service, 
        o.name,
        o.phone,
        o.address
      FROM trade_orders o
      WHERE o.post_id = $1 
        AND (o.sender_id = $2 OR o.receiver_id = $2)
      ORDER BY o.created_at DESC
      LIMIT 1
      `,
      [postId, userId]
    );

    if (!r.rowCount) {
      console.log(` No trade_order found for post_id=${postId}, user_id=${userId}`);
      return res.status(404).json({ error: 'ไม่พบคำสั่งเทรดสำหรับโพสต์นี้' });
    }

    const order = r.rows[0];
    console.log(`Found trade_order: order_id=${order.order_id}, trade_id=${order.trade_id}`);

    res.json({
      order_id: order.order_id,
      trade_id: order.trade_id,
      status: order.status,
      created_at: order.created_at,
      tracking_number: order.tracking_number,
      sender_id: order.sender_id,
      receiver_id: order.receiver_id,
      shipping: {
        name: order.name,
        phone: order.phone,
        address: order.address,
      }
    });
  } catch (err) {
    console.error('Error in GET /trade/by-post/:postId:', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

// Proposer confirm trade → close post + create ONE order (owner -> proposer)
router.post('/trade/:tradeId/confirm', requireAuth, textOnly.none(), async (req, res) => {
  const tradeId = Number(req.params.tradeId);
  const userId = req.user.id;

  console.log(`POST /trade/${tradeId}/confirm - userId=${userId}`);

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
      `UPDATE trade_orders 
       SET partner_confirmed_at = NOW(), updated_at = NOW()
       WHERE trade_id = $1`,
      [tradeId]
    );

    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
       VALUES ($1,$2,$3,$4), ($4,$5,$3,$1)`,
      [owner_id, 'Trade confirmed. Please prepare to send your item.', owner_post_id, trade.proposer_id, 'การเทรดยืนยันแล้ว กรุณาเตรียมส่งสินค้า']
    );

    await query('COMMIT');

    console.log(`Trade confirmed: ownerOrderId=${ownerOrderId}`);
    res.json({ ok: true, message: 'Trade confirmed. Owner-to-proposer shipment created.', ownerOrderId });
  } catch (e) {
    console.error('Error in /trade/:tradeId/confirm:', e);
    await query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: 'server error' });
  }
});
/**
 * POST /api/orders/trade/:id/trade-add-tracking
 * ผู้ส่ง (sender) ของใบนี้เท่านั้นที่ใส่เลขพัสดุได้
 * เปลี่ยน status -> shipping
 */
router.post('/trade/:id/trade-add-tracking', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  const { tracking_number, shipping_service } = req.body;
  const userId = req.user.id;

  if (!tracking_number)
    return res.status(400).json({ error: 'ต้องระบุ tracking number' });
  if (!shipping_service)
    return res.status(400).json({ error: 'ต้องระบุชื่อบริษัทขนส่ง' });

  try {
    await query('BEGIN');

    // อัปเดต order หลัก (ของ sender)
    const r = await query(
      `
      UPDATE trade_orders
      SET tracking_number=$1,
          shipping_service=$2,
          status='shipping',
          shipped_at=NOW(),
          updated_at=NOW()
      WHERE id=$3 AND sender_id=$4 AND status='waiting_shipping'
      RETURNING id, trade_id, status, tracking_number, shipping_service, receiver_id, post_id
      `,
      [tracking_number, shipping_service, orderId, userId]
    );

    if (!r.rowCount) {
      await query('ROLLBACK');
      return res
        .status(400)
        .json({ error: 'ไม่พบคำสั่งซื้อหรือสถานะไม่ถูกต้อง' });
    }

    const order = r.rows[0];

    // อัปเดตใบอีกฝั่ง (คู่เทรด) ให้ partner_shipped_at = NOW()
    await query(
      `
      UPDATE trade_orders
      SET partner_shipped_at = NOW(), updated_at = NOW()
      WHERE trade_id = $1
        AND id <> $2
        AND status IN ('waiting_shipping','shipping')
      `,
      [order.trade_id, order.id]
    );

    // แจ้งเตือนผู้รับ
    await query(
      `
      INSERT INTO notifications (user_id, message, post_id, actor_id)
      VALUES ($1, $2, $3, $4)
      `,
      [
        order.receiver_id,
        `คำสั่งซื้อของคุณถูกจัดส่งแล้วโดย ${shipping_service} หมายเลขพัสดุ: ${tracking_number}`,
        order.post_id,
        userId,
      ]
    );

    await query('COMMIT');

    res.json({ ok: true, order });
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});


/**
 * POST /api/orders/trade/:id/trade-confirm-delivery
 * ผู้รับ (receiver) ของใบนี้เท่านั้นที่กดได้
 * เปลี่ยน status -> completed
 */
router.post('/trade/:id/trade-confirm-delivery', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  const userId = req.user.id;

  try {
    await query('BEGIN');

    // อัปเดตใบของผู้รับเอง
    const r = await query(
      `
      UPDATE trade_orders
      SET status='completed', 
          delivered_at=NOW(), 
          updated_at=NOW()
      WHERE id=$1 
        AND receiver_id=$2 
        AND status IN ('shipping','waiting_shipping')
      RETURNING id, trade_id, status, sender_id, receiver_id, post_id
      `,
      [orderId, userId]
    );

    if (!r.rowCount) {
      await query('ROLLBACK');
      return res.status(400).json({ error: 'ไม่พบคำสั่งซื้อหรือสถานะไม่ถูกต้อง' });
    }

    const order = r.rows[0];

    // อัปเดตใบคู่เทรดให้ partner_delivered_at = NOW()
    await query(
      `
      UPDATE trade_orders
      SET partner_delivered_at = NOW(), updated_at = NOW()
      WHERE trade_id = $1
        AND id <> $2
        AND status IN ('shipping','completed','waiting_shipping')
      `,
      [order.trade_id, order.id]
    );

    // แจ้งเตือนผู้ส่ง
    await query(
      `
      INSERT INTO notifications (user_id, message, post_id, actor_id)
      VALUES ($1, $2, $3, $4)
      `,
      [
        order.sender_id,
        'ผู้รับยืนยันการจัดส่ง สถานะการเทรดเสร็จสมบูรณ์',
        order.post_id,
        userId,
      ]
    );

    await query('COMMIT');

    res.json({ ok: true, order });
  } catch (err) {
    await query('ROLLBACK').catch(() => {});
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
      `
      SELECT 
        o.id AS order_id,
        o.trade_id,
        o.sender_id,
        su.username AS sender_username,
        su.profile_image_url AS sender_profile_image_url,
        COALESCE(ROUND(AVG(srs.rating)::numeric,1),0) AS sender_rating,
        COUNT(srs.rating) AS sender_review_count,

        o.receiver_id,
        ru.username AS receiver_username,
        ru.profile_image_url AS receiver_profile_image_url,
        COALESCE(ROUND(AVG(rrs.rating)::numeric,1),0) AS receiver_rating,
        COUNT(rrs.rating) AS receiver_review_count,

        o.status,
        o.created_at,
        o.updated_at,
        o.tracking_number,
        o.shipping_service, 
        o.name,
        o.phone,
        o.address,

        -- เพิ่ม timestamps ไทม์ไลน์การเทรด
        o.partner_confirmed_at,
        o.shipped_at,
        o.partner_shipped_at,
        o.delivered_at,
        o.partner_delivered_at,

        -- เพิ่ม is_owner ใน posts
        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'post_id', p.id,
                'post_title', p.title,
                'description', p.description,
                'tags', p.tags,
                'image_url', p.image_url,
                'status', p.status,
                'is_owner', CASE 
                  WHEN p.user_id = $1 AND o.receiver_id = $1 THEN true 
                  ELSE false 
                END
              )
            )
            FROM trade_posts tp
            JOIN posts p ON p.id = tp.post_id
            WHERE tp.trade_id = o.trade_id
          ),
          '[]'::json
        ) AS posts,

        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'title', ti.title,
                'description', ti.description,
                'tags', ti.tags,
                'images', COALESCE(NULLIF(ti.image_url,'')::json,'[]'::json)
              )
            )
            FROM trade_items ti
            WHERE ti.trade_id = o.trade_id
          ),
          '[]'::json
        ) AS items

      FROM trade_orders o
      JOIN users su ON su.id = o.sender_id
      JOIN users ru ON ru.id = o.receiver_id
      LEFT JOIN seller_reviews srs ON srs.seller_id = su.id
      LEFT JOIN seller_reviews rrs ON rrs.seller_id = ru.id
      WHERE o.sender_id = $1 OR o.receiver_id = $1
      GROUP BY o.id, su.id, ru.id
      ORDER BY o.created_at DESC
      `,
      [userId]
    );

    res.json({ myTrades: r.rows });
  } catch (err) {
    console.error('Error in GET /trade/my:', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});



/**
 * GET /api/orders/trade/:id เพิ่ม username
 * รายละเอียดใบ trade order
 */
router.get('/trade/:id', requireAuth, async (req, res) => {
  const orderId = Number(req.params.id);
  const userId = req.user.id;

  console.log(`GET /trade/${orderId} - userId=${userId}`);

  try {
    const r = await query(
      `
      SELECT 
        o.id AS order_id,
        o.trade_id,
        o.sender_id,
        su.username AS sender_username,
        su.profile_image_url AS sender_profile_image_url,
        COALESCE(ROUND(AVG(srs.rating)::numeric,1),0) AS sender_rating,
        COUNT(srs.rating) AS sender_review_count,

        o.receiver_id,
        ru.username AS receiver_username,
        ru.profile_image_url AS receiver_profile_image_url,
        COALESCE(ROUND(AVG(rrs.rating)::numeric,1),0) AS receiver_rating,
        COUNT(rrs.rating) AS receiver_review_count,

        o.status,
        o.created_at,
        o.tracking_number,
        o.shipping_service, 
        o.name,
        o.phone,
        o.address,

        COALESCE(
  (
    SELECT json_agg(json_build_object(
      'post_id', p.id,
      'post_title', p.title,
      'user_id', p.user_id,
      'description', p.description,
      'tags', p.tags,
      'image_url', p.image_url,
      'seller_rating', COALESCE(sub.avg_rating, 0),
      'review_count', COALESCE(sub.review_count, 0)
    ))
    FROM trade_posts tp
    JOIN posts p ON p.id = tp.post_id
    LEFT JOIN (
      SELECT seller_id, ROUND(AVG(rating)::numeric,1) AS avg_rating, COUNT(rating) AS review_count
      FROM seller_reviews
      GROUP BY seller_id
    ) sub ON sub.seller_id = p.user_id
    WHERE tp.trade_id = o.trade_id
  ),
  '[]'::json
) AS posts

      FROM trade_orders o
      JOIN users su ON su.id = o.sender_id
      JOIN users ru ON ru.id = o.receiver_id
      LEFT JOIN seller_reviews srs ON srs.seller_id = su.id
      LEFT JOIN seller_reviews rrs ON rrs.seller_id = ru.id
      WHERE o.id = $1 AND (o.sender_id = $2 OR o.receiver_id = $2)
      GROUP BY 
        o.id, su.id, ru.id
      `,
      [orderId, userId]
    );

    if (!r.rowCount) {
      console.log(`No trade_order found for order_id=${orderId}, user_id=${userId}`);
      return res.status(404).json({ error: 'ไม่พบใบสั่งเทรดนี้' });
    }

    const row = r.rows[0];
    console.log(`Found trade_order: order_id=${row.order_id}, posts=${row.posts?.length || 0}`);

    res.json({
      order_id: row.order_id,
      trade_id: row.trade_id,
      status: row.status,
      created_at: row.created_at,
      tracking_number: row.tracking_number,
      shipping_service: row.shipping_service, 
      sender: {
        id: row.sender_id,
        username: row.sender_username,
        profile_image_url: row.sender_profile_image_url,
        rating: Number(row.sender_rating),
        review_count: Number(row.sender_review_count),
      },
      receiver: {
        id: row.receiver_id,
        username: row.receiver_username,
        profile_image_url: row.receiver_profile_image_url,
        rating: Number(row.receiver_rating),
        review_count: Number(row.receiver_review_count),
      },
      shipping: {
        name: row.name,
        phone: row.phone,
        address: row.address,
      },
      posts: row.posts ?? [],
    });    
  } catch (err) {
    console.error('Error in GET /trade/:id:', err);
    res.status(500).json({ error: 'server error', details: err.message });
  }
});

export default router;
//alice 2 offer diana 5 post 4 terade 1