
import { Router } from 'express';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

// GET /api/comments/:postId  -> flat list (includes parent_comment_id)
router.get('/:postId', async (req, res) => {
  const postId = Number(req.params.postId);
  if (!Number.isInteger(postId)) return res.status(400).json({ error: 'invalid postId' });

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

// POST /api/comments/:postId  -> create comment or reply
// body: { body: string, parent_comment_id?: number|null }
router.post('/:postId', requireAuth, async (req, res) => {
  const postId = Number(req.params.postId);
  if (!Number.isInteger(postId)) return res.status(400).json({ error: 'invalid postId' });

  const incoming = req.body;
  const body = (typeof incoming === 'string' ? incoming : (incoming.body || '')).trim();
  const parentRaw = typeof incoming === 'object' && incoming !== null ? incoming.parent_comment_id : null;
  const parentId = parentRaw === undefined || parentRaw === null || parentRaw === '' ? null : Number(parentRaw);

  if (!body) return res.status(400).json({ error: 'Empty' });
  if (parentId !== null && !Number.isInteger(parentId)) {
    return res.status(400).json({ error: 'invalid parent_comment_id' });
  }

  // Ensure post exists and comments allowed
  const st = await query(`SELECT status FROM posts WHERE id=$1`, [postId]);
  if (!st.rowCount) return res.status(404).json({ error: 'post not found' });
  if (st.rows[0].status === 'pending' || st.rows[0].status === 'waiting') {
    return res.status(400).json({ error: 'Comments are disabled for this post status' });
  }

  // When replying, ensure the parent comment exists and belongs to same post
  if (parentId !== null) {
    const pr = await query(`SELECT post_id FROM comments WHERE id=$1`, [parentId]);
    if (!pr.rowCount) return res.status(404).json({ error: 'parent comment not found' });
    if (pr.rows[0].post_id !== postId) {
      return res.status(400).json({ error: 'parent_comment_id does not belong to this post' });
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

export default router;
