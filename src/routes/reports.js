import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { query } from '../db.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const reportDir = path.join(process.cwd(), 'uploads', 'reports');
if (!fs.existsSync(reportDir))
  fs.mkdirSync(reportDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req,file,cb)=>cb(null, reportDir),
  filename: (req,file,cb)=>cb(null, Date.now() + '-' + Math.round(Math.random()*1e9) + path.extname(file.originalname))
});
const upload = multer({ storage });

//สร้างรีพอร์ต
router.post('/', requireAuth, upload.array('images', 8), async (req,res)=>{
  try{
    const { target_user_id, details } = req.body;
    if (!target_user_id)
      return res.status(400).json({ error: 'target_user_id required' });

    //เหตุผล
    let reasons = req.body.reasons;
    if (Array.isArray(reasons))
      reasons = reasons.map(s => String(s).trim()).filter(Boolean).join(',');
    else if (typeof reasons === 'string')
      reasons = reasons.split(',').map(s => s.trim()).filter(Boolean).join(',');
    else reasons = '';

    //รูป
    const filesArr = (req.files||[]).map(f=>f.filename);
    const imagesJson = JSON.stringify(filesArr);

    const type = 'user'; // IMPORTANT: satisfy NOT NULL type columns

    const r = await query(
      'INSERT INTO reports (reporter_id,target_user_id,type,reasons,details,images) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [req.user.id, Number(target_user_id), type, reasons, details || '', imagesJson]
    );

    //แจ้งเตือนแอดมิน
    const admins = await query('SELECT id FROM users WHERE role=\'admin\'');
    const msg = 'มีรีพอร์ตผู้ใช้ใหม่ #' + r.rows[0].id;
    for (const a of admins.rows) {
      await query('INSERT INTO notifications (user_id, message) VALUES ($1,$2)', [a.id, msg]);
    }
    res.json({ ok: true, id: r.rows[0].id });
  }catch(e){
    console.error(e);
    res.status(500).json({ error: 'failed to create report' });
  }
});
export default router;