import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

function isValidRating(x) {
  const n = Number(x);
  return Number.isInteger(n) && n >= 1 && n <= 5;
}

//สร้างรีวิวให้ผู้ขาย (ต้องล็อกอิน และ status='review')
router.post('/', requireAuth, async (req, res) => {
  try {
    const reviewerId = req.user.id;
    const { sellerId, rating, comment, orderId = null } = req.body ?? {};

    if (!Number.isInteger(Number(sellerId)) || Number(sellerId) <= 0)
      return res.status(400).json({ error: 'sellerId must be a positive integer' });
    if (!isValidRating(rating))
      return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
    if (!comment || String(comment).trim().length === 0)
      return res.status(400).json({ error: 'comment is required' });
    if (Number(sellerId) === Number(reviewerId))
      return res.status(403).json({ error: 'cannot review yourself' });

    const s = await query('SELECT id FROM users WHERE id=$1', [sellerId]);
    if (s.rows.length === 0)
      return res.status(404).json({ error: 'seller not found' });

    if (orderId) {
      const o = await query('SELECT status, seller_id, post_id FROM orders WHERE id=$1', [orderId]);
      if (o.rows.length === 0)
        return res.status(404).json({ error: 'order not found' });
      if (o.rows[0].status !== 'review')
        return res.status(400).json({ error: 'This order has not been completed yet and cannot be reviewed' });

      const insertSQL = `
        INSERT INTO seller_reviews (reviewer_id, seller_id, order_id, rating, comment)
        VALUES ($1,$2,$3,$4,$5)
        RETURNING id, reviewer_id AS "reviewerId", seller_id AS "sellerId",
                  order_id AS "orderId", rating, comment, created_at AS "createdAt"
      `;
      const ins = await query(insertSQL, [
        reviewerId,
        Number(sellerId),
        Number(orderId),
        Number(rating),
        String(comment).trim()
      ]);

      await query(
        `UPDATE orders
           SET status='completed', updated_at=NOW()
         WHERE id=$1`,
        [orderId]
      );

      await query(
        `INSERT INTO notifications (user_id, message, post_id, actor_id)
         VALUES ($1,$2,$3,$4)`,
        [
          o.rows[0].seller_id,
          `You received a new review: ${rating} stars${comment ? ' - ' + comment : ''}`,
          o.rows[0].post_id,
          reviewerId
        ]
      );

      return res.status(201).json(ins.rows[0]);
    }

    return res.status(400).json({ error: 'orderId is required for review' });
  } catch (err) {
    if (err?.code === '23505')
      return res.status(409).json({ error: 'you have already reviewed this seller' });
    if (err?.code === '23514')
      return res.status(400).json({ error: 'rating must be an integer between 1 and 5' });
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

//ดึงรายการรีวิวของผู้ขายตาม sellerId
router.get('/users/:sellerId/reviews', async (req, res) => {
  const sellerId = Number(req.params.sellerId);
  const limit = Math.max(1, Math.min(100, Number(req.query.limit ?? 10)));
  const offset = Math.max(0, Number(req.query.offset ?? 0));
  if (!Number.isInteger(sellerId) || sellerId <= 0)
    return res.status(400).json({ error: 'invalid sellerId' });

  try {
    const listSQL = `
      SELECT r.id, r.rating, r.comment, r.created_at AS "createdAt",
             r.order_id AS "orderId",
             u.id AS "reviewerId", u.username AS "reviewerName",
             u.profile_image_url AS "reviewerAvatar"
      FROM seller_reviews r
      JOIN users u ON u.id = r.reviewer_id
      WHERE r.seller_id = $1
      ORDER BY r.created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const { rows } = await query(listSQL, [sellerId, limit, offset]);
    const countRes = await query(
      'SELECT COUNT(*)::int AS count FROM seller_reviews WHERE seller_id=$1',
      [sellerId]
    );
    return res.json({ total: countRes.rows[0].count, items: rows });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

//ดึงสรุปคะแนนรีวิวของผู้ขาย (average, count, distribution)
router.get('/users/:sellerId/rating_summary', async (req, res) => {
  const sellerId = Number(req.params.sellerId);
  if (!Number.isInteger(sellerId) || sellerId <= 0)
    return res.status(400).json({ error: 'invalid sellerId' });

  try {
    const avgSQL = `
      SELECT ROUND(AVG(rating)::numeric, 1) AS avg, COUNT(*)::int AS count
      FROM seller_reviews WHERE seller_id=$1
    `;
    const { rows: a } = await query(avgSQL, [sellerId]);

    const distSQL = `
      SELECT rating, COUNT(*)::int AS c
      FROM seller_reviews
      WHERE seller_id=$1
      GROUP BY rating
      ORDER BY rating ASC
    `;
    const { rows: d } = await query(distSQL, [sellerId]);

    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const row of d) {
      distribution[row.rating] = row.c;
    }

    return res.json({
      sellerId,
      average: a[0]?.avg ? Number(a[0].avg) : 0.0,
      count: a[0]?.count ?? 0,
      distribution
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'server error' });
  }
});

export default router;