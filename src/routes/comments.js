import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// ดึงคอมเมนต์ทั้งหมดของโพสต์ตาม postId
router.get('/:postId', async (req, res) => {
  const postId = Number(req.params.postId);
  if (!Number.isInteger(postId))
    return res.status(400).json({ error: 'postId ไม่ถูกต้อง' });

  const r = await query(
    `SELECT c.id, c.post_id, c.user_id, u.username, c.body, c.parent_comment_id, c.created_at
     FROM comments c
     JOIN users u ON u.id = c.user_id
     WHERE c.post_id = $1
     ORDER BY c.created_at DESC, c.id DESC`,
    [postId]
  );
  res.json(r.rows);
});

// เพิ่มคอมเมนต์ใหม่ในโพสต์
router.post('/:postId', requireAuth, async (req, res) => {
  const postId = Number(req.params.postId);
  if (!Number.isInteger(postId))
    return res.status(400).json({ error: 'postId ไม่ถูกต้อง' });

  const incoming = req.body;
  const body = (typeof incoming === 'string' ? incoming : (incoming.body || '')).trim();
  const parentRaw = typeof incoming === 'object' && incoming !== null ? incoming.parent_comment_id : null;
  const parentId = parentRaw === undefined || parentRaw === null || parentRaw === '' ? null : Number(parentRaw);

  if (!body)
    return res.status(400).json({ error: 'คอมเมนต์ไม่สามารถว่างเปล่าได้' });
  if (parentId !== null && !Number.isInteger(parentId)) {
    return res.status(400).json({ error: 'parent_comment_id ไม่ถูกต้อง' });
  }

  const st = await query(`SELECT status FROM posts WHERE id=$1`, [postId]);
  if (!st.rowCount)
    return res.status(404).json({ error: 'ไม่พบโพสต์' });
  if (st.rows[0].status === 'pending' || st.rows[0].status === 'waiting') {
    return res.status(400).json({ error: 'ไม่สามารถแสดงความคิดเห็นได้ในสถานะนี้' });
  }

  if (parentId !== null) {
    const pr = await query(`SELECT post_id FROM comments WHERE id=$1`, [parentId]);
    if (!pr.rowCount)
      return res.status(404).json({ error: 'ไม่พบคอมเมนต์' });
    if (pr.rows[0].post_id !== postId) {
      return res.status(400).json({ error: 'parent_comment_id ไม่ถูกต้อง' });
    }
  }

  const ins = await query(
    `INSERT INTO comments (post_id, user_id, body, parent_comment_id)
     VALUES ($1,$2,$3,$4)
     RETURNING id, post_id, user_id, body, parent_comment_id, created_at`,
    [postId, req.user.id, body, parentId]
  );

  res.status(201).json(ins.rows[0]);
});

// ลบคอมเมนต์
router.delete('/:commentId', requireAuth, async (req, res) => {
  const commentId = Number(req.params.commentId);
  if (!Number.isInteger(commentId))
    return res.status(400).json({ error: 'commentId ไม่ถูกต้อง' });

  const comment = await query(
    `SELECT c.id, c.user_id, c.post_id, p.user_id as post_owner_id
     FROM comments c
     JOIN posts p ON p.id = c.post_id
     WHERE c.id = $1`,
    [commentId]
  );
  
  if (!comment.rowCount)
    return res.status(404).json({ error: 'ไม่พบคอมเมนต์' });
  
  const isCommentOwner = comment.rows[0].user_id === req.user.id;
  const isPostOwner = comment.rows[0].post_owner_id === req.user.id;
  const isAdmin = req.user.role === 'admin';
  
  if (!isCommentOwner && !isPostOwner && !isAdmin)
    return res.status(403).json({ error: 'คุณสามารถลบคอมเมนต์ของตัวเองได้เท่านั้น' });

  await query('DELETE FROM comments WHERE id=$1', [commentId]);

  res.json({ ok: true, message: 'ลบคอมเมนต์เรียบร้อยแล้ว' });
});

export default router;