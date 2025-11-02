import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ✅ ดึงการแจ้งเตือนของผู้ใช้ (ต้องล็อกอิน)
router.get('/', requireAuth, async (req, res) => {
  try {
    console.log('👤 Fetching notifications for user:', req.user.id);

    const result = await query(`
      SELECT 
        n.id,
        n.message,
        n.created_at,
        n.read,
        n.post_id,
        p.title AS post_title,
        CASE 
          WHEN p.image_url IS NULL THEN NULL
          WHEN jsonb_typeof(p.image_url::jsonb) = 'array' THEN 
            CASE 
              WHEN jsonb_array_length(p.image_url::jsonb) > 0 THEN p.image_url::jsonb->>0
              ELSE NULL
            END
          WHEN jsonb_typeof(p.image_url::jsonb) = 'string' THEN p.image_url::text
          ELSE NULL
        END AS post_image
      FROM notifications n
      LEFT JOIN posts p ON n.post_id = p.id
      WHERE n.user_id = $1
      ORDER BY n.created_at DESC
    `, [req.user.id]);

    console.log(`✅ Found ${result.rows.length} notifications`);

    res.json(result.rows);
  } catch (err) {
    console.error('❌ Error fetching notifications:', err.message);
    console.error('Stack:', err.stack);
    res.status(500).json({
      error: 'Internal Server Error',
      message: err.message
    });
  }
});

// ✅ ตั้งค่า read = true
router.post('/:id/read', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE notifications 
       SET read = true 
       WHERE id = $1 AND user_id = $2
       RETURNING id, read`,
      [req.params.id, req.user.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Notification not found' });
    }

    console.log(`✅ Marked notification ${req.params.id} as read`);
    res.json({ ok: true, notification: result.rows[0] });
  } catch (err) {
    console.error('❌ Error marking as read:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ✅ ตั้งค่าอ่านทั้งหมด
router.post('/read-all', requireAuth, async (req, res) => {
  try {
    const result = await query(
      `UPDATE notifications 
       SET read = true 
       WHERE user_id = $1 AND read = false
       RETURNING id`,
      [req.user.id]
    );

    console.log(`✅ Marked ${result.rows.length} notifications as read`);
    res.json({ ok: true, count: result.rows.length });
  } catch (err) {
    console.error('❌ Error marking all as read:', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

export default router;
