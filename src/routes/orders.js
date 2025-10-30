import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * ✅ Buyer กดซื้อ → สร้าง Order
 * state เริ่มต้น: waiting_payment อยู่ในหน้าโพสต์

/**
 * ✅ Seller กดยืนยันเงินเข้า
 * เปลี่ยนสถานะ → payment_confirmed
 */
router.post('/:id/confirm-payment', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user.id;

  try {
    // ต้องเป็น seller เท่านั้น และต้องอยู่ในสถานะ waiting_confirm
    const r = await query(
      `UPDATE orders
       SET status='payment_confirmed', updated_at=NOW()
       WHERE id=$1 AND seller_id=$2 AND status='waiting_confirm'
       RETURNING id, status, buyer_id, post_id`,  
      [orderId, userId]
    );

    if (!r.rowCount) {
      return res.status(400).json({ error: 'ไม่พบคำสั่งซื้อหรือสถานะไม่ถูกต้อง' });
    }

    // แจ้งเตือนผู้ซื้อ
    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
       VALUES ($1,$2,$3,$4)`,
      [
        r.rows[0].buyer_id,
        'การชำระเงินของคุณได้รับการยืนยันแล้ว รอผู้ขายจัดส่ง',
        r.rows[0].post_id,
        userId
      ]
    );

    res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * ✅ Seller ใส่เลขพัสดุ
 * เปลี่ยนสถานะ → shipping
 */
router.post('/:id/add-tracking', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const { tracking_number, shipping_service } = req.body;  const userId = req.user.id;

  if (!tracking_number) return res.status(400).json({ error: 'ต้องระบุ tracking_number' });
  if (!shipping_service) return res.status(400).json({ error: 'ต้องระบุ shipping_service' });

  try {
    const r = await query(`
      UPDATE orders
      SET tracking_number = $1,
          shipping_service = $2,  
          status = 'shipping',
          updated_at = NOW()
      WHERE id = $3
        AND seller_id = $4
        AND status = 'payment_confirmed'
      RETURNING id, status, tracking_number, shipping_service, buyer_id, post_id`,
      [tracking_number, shipping_service, orderId, userId]
    );

    if (!r.rowCount) return res.status(400).json({ error: 'ไม่พบคำสั่งซื้อหรือสถานะไม่ถูกต้อง' });

    // แจ้งเตือนผู้ซื้อ
    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
       VALUES ($1,$2,$3,$4)`,
      [
        r.rows[0].buyer_id,
        `คำสั่งซื้อของคุณถูกจัดส่งแล้ว (${shipping_service}) หมายเลขพัสดุ: ${tracking_number}`,
        r.rows[0].post_id,
        userId
      ]
    );
    res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

/**
 *  Buyer ยืนยันได้รับของ
 * เปลี่ยนสถานะ → delivered (แล้วระบบสามารถ mark เป็น review ได้ต่อไป)
 */
router.post('/:id/confirm-delivery', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user.id;

  try {
    const r = await query(`UPDATE orders
      SET status='review', updated_at=NOW()
      WHERE id=$1 AND buyer_id=$2 AND status='shipping'
      RETURNING id, status, seller_id, post_id`,
      [orderId, userId]);

    if (!r.rowCount) return res.status(400).json({ error: 'ไม่พบคำสั่งซื้อหรือสถานะไม่ถูกต้อง' });

    // แจ้งเตือนผู้ขาย
    await query(
      `INSERT INTO notifications (user_id, message, post_id, actor_id)
       VALUES ($1,$2,$3,$4)`,
      [
        r.rows[0].seller_id,
        'ผู้ซื้อได้ยืนยันการจัดส่งแล้ว รอการรีวิว',
        r.rows[0].post_id,
        userId
      ]
    );
    res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * ✅ ดึงเฉพาะออเดอร์ที่เราเป็นผู้ขาย
 */
router.get('/my-sell', requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const r = await query(
      `SELECT o.*, p.title, p.image_url, u.username AS buyer_name
       FROM orders o
       JOIN posts p ON p.id = o.post_id
       JOIN users u ON u.id = o.buyer_id
       WHERE o.seller_id = $1
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
 * ✅ ดึง Order ของ user (ทั้ง buyer & seller)
 */
router.get('/my', requireAuth, async (req, res) => {
  const userId = req.user.id;

  try {
    const r = await query(
      `SELECT o.*, p.title, p.image_url
       FROM orders o
       JOIN posts p ON p.id=o.post_id
       WHERE o.buyer_id=$1 OR o.seller_id=$1
       ORDER BY o.created_at DESC`,
      [userId]
    );

    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * ✅ ดึงรายละเอียด Order ตาม id
 */
router.get('/:id', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user.id;

  try {
    const r = await query(
      `SELECT o.*, p.title, p.image_url, u.username AS seller_name
       FROM orders o
       JOIN posts p ON p.id=o.post_id
       JOIN users u ON u.id=o.seller_id
       WHERE o.id=$1 AND (o.buyer_id=$2 OR o.seller_id=$2)`,
      [orderId, userId]
    );

    if (!r.rowCount) return res.status(404).json({ error: 'ไม่พบคำสั่งซื้อ' });

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

export default router;