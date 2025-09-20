import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * ✅ Buyer กดซื้อ → สร้าง Order
 * state เริ่มต้น: waiting_payment
 */
router.post('/', requireAuth, async (req, res) => {
  const { post_id } = req.body;
  const buyer_id = req.user.id;

  if (!post_id) return res.status(400).json({ error: 'post_id is required' });

  try {
    // ดึง seller ของโพสต์
    const post = await query(`SELECT user_id FROM posts WHERE id=$1`, [post_id]);
    if (!post.rowCount) return res.status(404).json({ error: 'Post not found' });
    const seller_id = post.rows[0].user_id;

    if (seller_id === buyer_id) {
      return res.status(400).json({ error: 'Cannot order your own post' });
    }

    // เช็คว่ามี order ซ้ำหรือยัง
    const existing = await query(
      `SELECT 1 FROM orders WHERE post_id=$1 AND buyer_id=$2`,
      [post_id, buyer_id]
    );
    if (existing.rowCount) {
      return res.status(400).json({ error: 'Order already exists' });
    }

    const r = await query(
      `INSERT INTO orders (post_id, buyer_id, seller_id, status)
       VALUES ($1, $2, $3, 'waiting_confirm')
       RETURNING id, status`,
      [post_id, buyer_id, seller_id]
    );

    res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * ✅ Seller กดยืนยันเงินเข้า
 * เปลี่ยนสถานะ → payment_confirmed
 */
router.post('/:id/confirm-payment', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user.id;

  try {
    // ต้องเป็น seller เท่านั้น
    const r = await query(`UPDATE orders
      SET status='payment_confirmed', updated_at=NOW()
      WHERE id=$1 AND seller_id=$2 AND status='waiting_confirm'
      RETURNING id, status`, [orderId, userId]);

    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or invalid state' });

    res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

/**
 * ✅ Seller ใส่เลขพัสดุ
 * เปลี่ยนสถานะ → shipping
 */
router.post('/:id/add-tracking', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const { tracking_number } = req.body;
  const userId = req.user.id;

  if (!tracking_number) return res.status(400).json({ error: 'tracking_number is required' });

  try {
    const r = await query(`UPDATE orders
      SET tracking_number=$1, status='shipping', updated_at=NOW()
      WHERE id=$2 AND seller_id=$3 AND status='payment_confirmed'
      RETURNING id, status, tracking_number`,
      [tracking_number, orderId, userId]);

    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or invalid state' });

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
      RETURNING id, status`,
      [orderId, userId]);

    if (!r.rowCount) return res.status(400).json({ error: 'Order not found or invalid state' });

    res.json({ ok: true, order: r.rows[0] });
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

router.post('/:id/review', requireAuth, async (req, res) => {
  const orderId = req.params.id;
  const { rating, comment } = req.body;
  const userId = req.user.id;

  try {
    // 1. เช็คว่า order มีอยู่จริง และ status ต้องเป็น review
    const r = await query(
      `SELECT * FROM orders WHERE id=$1 AND buyer_id=$2`,
      [orderId, userId]
    );

    if (!r.rowCount || r.rows[0].status !== 'review') {
      return res.status(400).json({ error: `Order not in review state (current: ${r.rows[0].status})` });
    }

    // 2. อัปเดตคะแนนและรีวิว
    await query(
      `UPDATE orders
       SET rating=$1, review=$2, status='completed', updated_at=NOW()
       WHERE id=$3`,
      [rating, comment || null, orderId]
    );

    res.json({ ok: true, message: 'Review submitted successfully' });
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

    if (!r.rowCount) return res.status(404).json({ error: 'Order not found' });

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: 'server error' });
  }
});

export default router;
