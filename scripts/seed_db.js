import bcrypt from 'bcryptjs';
import { query, pool } from '../src/db.js';

const IMG =
  'https://www.apple.com/v/iphone/home/cc/images/overview/consider_modals/environment/modal_trade_in_variant__ejij0q8th06e_large.jpg';

// ====================================
// 👤 USER SEED (เวอร์ชันที่มีรูป + อัปเดตได้)
// ====================================
async function upsertUser(username, role = 'user', profileUrl = null, password = null) {
  const passwordToHash = password || username;
  const hash = await bcrypt.hash(passwordToHash, 10);
  
  // อธิบาย:
  // - ถ้ายังไม่มี user → insert ปกติ
  // - ถ้ามีอยู่แล้ว → อัปเดต role ให้ตรงกับ seed
  // - รูป: ถ้าใน DB เดิมยังเป็น null → ใช้รูปจาก seed
  //        ถ้าใน DB เดิมมีรูปอยู่แล้ว → ไม่ทับ
  const inserted = await query(
    `INSERT INTO users (username, password_hash, role, tokens, is_active, profile_image_url)
     VALUES ($1, $2, $3, 100, true, $4)
     ON CONFLICT (username)
     DO UPDATE SET
        role = EXCLUDED.role,
        profile_image_url = COALESCE(users.profile_image_url, EXCLUDED.profile_image_url)
     RETURNING id`,
    [username, hash, role, profileUrl]
  );

  if (inserted.rows.length) {
    return inserted.rows[0].id;
  }

  // กรณีที่ RETURNING ไม่ได้ (บาง PG ตั้งค่าไว้) → ดึงอีกรอบ
  const r = await query('SELECT id FROM users WHERE username=$1', [username]);
  return r.rows[0].id;
}

// ====================================
// 🛒 POST SEED (ของเดิมคุณ ใช้ desc ยาว + รูปหลายรูป)
// ====================================
async function insertPostIfNotExists(p) {
  await query(
    `INSERT INTO posts
       (user_id, title, description, price, is_sell, is_trade, tags, special_tags, image_url, status, promoted, promoted_at)
     SELECT
       $1::int,
       $2::varchar,
       $3::text,
       $4::numeric,
       $5::boolean,
       $6::boolean,
       $7::text[],
       $8::text[],
       $9::text,
       $10::post_status,
       $11::boolean,
       CASE WHEN $11 = true THEN NOW() ELSE NULL END
     WHERE NOT EXISTS (
       SELECT 1 FROM posts
        WHERE user_id = $1::int
          AND title   = $2::varchar
     )`,
    [
      p.user_id,
      p.title,
      p.description,
      p.price,
      p.is_sell,
      p.is_trade,
      p.tags,
      p.special_tags || [],
      JSON.stringify(p.image_url),
      p.status,
      p.promoted || false,
    ]
  );
}

// ====================================
// 💬 COMMENT SEED (เวอร์ชันที่จัด parent/child ไว้เรียบร้อย)
//      ✅ เพิ่ม guard ไม่ให้ seed ซ้ำถ้ามีอยู่แล้ว
// ====================================
async function insertComment(
  postId,
  userId,
  body,
  parentId = null,
  createdAt = null
) {
  const r = await query(
    `INSERT INTO comments (post_id, user_id, body, parent_comment_id, created_at)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [postId, userId, body, parentId, createdAt || new Date()]
  );
  return r.rows[0].id;
}

async function seedCommentsForPost(postId, ownerId, ids) {
  // ✅ กันไว้ก่อนเลย ถ้ามีคอมเมนต์ของโพสต์นี้อยู่แล้ว ไม่ต้อง seed ซ้ำ
  const existing = await query(
    `SELECT COUNT(*) AS c FROM comments WHERE post_id = $1`,
    [postId]
  );
  if (Number(existing.rows[0].c) > 0) {
    // มีแล้ว ข้าม
    return;
  }

  // thread 1
  const c1 = await insertComment(
    postId,
    ids['wednesday addams'],
    'มีใครเคยซื้อกับคนนี้ไหมคะ'
  );
  await insertComment(
    postId,
    ids['Enid Sinclair'],
    'เคยค่ะ ได้ของสภาพดีเลย',
    c1
  );
  await insertComment(
    postId,
    ids['tyler galpin'],
    'เคยหลายครั้ง เจ้าของร้านให้ของแถมด้วยครับ',
    c1
  );

  // thread 2
  await insertComment(postId, ids['morticia addams'], 'ส่งไวสุดเมื่อไหร่คะ');

  // thread 3
  await insertComment(postId, ids['Bella'], 'ขอแอดไลน์ไปนะคะ');

  // thread 4
  const c4 = await insertComment(
    postId,
    ids['agnes demille'],
    'มีกล่องมั้ยคะ'
  );
  await insertComment(postId, ownerId, 'มีกล่องให้', c4);

  // thread 5
  const c5 = await insertComment(postId, ids['James'], 'แท้ไหมครับ');
  await insertComment(
    postId,
    ids['Jackson'],
    'ผมดูจากภาพไม่น่าแท้นะครับ',
    c5
  );
  await insertComment(postId, ownerId, 'แท้ 100%', c5);
}

// ====================================
// 🔔 NOTIFICATION HELPER (เวอร์ชันที่แยก tokens แล้ว)
// ====================================
async function insertNotification(
  userId,
  message,
  createdAt = null,
  postId = null,
  actorId = null
) {
  await query(
    `INSERT INTO notifications (user_id, message, created_at, post_id, actor_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, message, createdAt || new Date(), postId, actorId]
  );
}


// ====================================
// 📣 PROMOTE NOTI HELPER
// ====================================
async function insertPromoteNotisForUser(userId, posts, cost = 20) {
  // posts: เป็น array ของ {id, title, user_id}
  if (!posts || posts.length === 0) return;

  // เลือกโพสต์ที่เป็นของ user นี้ก่อน
  const ownPosts = posts.filter((p) => p.user_id === userId);

  // ถ้าไม่มีโพสต์ของตัวเองเลย ให้ใช้โพสต์รวม
  const pickFrom = ownPosts.length > 0 ? ownPosts : posts;

  // เอาแค่ 4 อันพอ
  const limit = Math.min(4, pickFrom.length);

  for (let i = 0; i < limit; i++) {
    const p = pickFrom[i];
    await insertNotification(
      userId,
      `โปรโมทโพสต์ ${p.title} สำเร็จ! (หักโทเคน ${cost} tokens)`,
      new Date(),       // ตอนนี้เลย
      p.id,             // ผูกกับโพสต์
      null              // ไม่ต้องมี actor_id
    );
  }
}


// ====================================
// 🚀 MAIN SEED RUN
// ====================================
async function run() {
  // ===== USERS (ครบทุกคน) =====
  const users = [
    { name: 'admin', role: 'admin' },
    {
      name: 'taifoon',
      role: 'user',
      img: 'https://down-th.img.susercontent.com/file/e2fd3a2bfb6d0f569bd96f43add535fa',
    },
    {
      name: 'gun',
      role: 'user',
      img: 'https://t3.ftcdn.net/jpg/06/99/46/60/360_F_699466075_DaPTBNlNQTOwwjkOiFEoOvzDV0ByXR9E.jpg',
    },
    {
      name: 'focus',
      role: 'user',
      img: 'https://pbs.twimg.com/profile_images/1816960260562673665/SRSE3nzR_400x400.jpg',
    },
    {
      name: 'toey',
      role: 'user',
      img: 'https://t4.ftcdn.net/jpg/06/07/03/05/360_F_607030560_zllEoLiMDZNXEfEGjl4VVrHwDKyRPhh4.jpg',
    },
    {
      name: 'candy',
      role: 'user',
      img: 'https://i.pinimg.com/1200x/c6/ce/e0/c6cee08fa28d3a1afc1b1302c59cf08c.jpg',
    },
    {
      name: 'pink',
      role: 'user',
      img: 'https://img.freepik.com/photos-premium/visage-du-mannequin-coreen_825367-1868.jpg',
    },
    {
      name: 'wednesday addams',
      role: 'user',
      img: 'https://static.wikia.nocookie.net/timburton/images/a/a1/WednesdayAddamsNetflix.jpg/revision/latest?cb=20221206163305',
    },
    {
      name: 'Enid Sinclair',
      role: 'user',
      img: 'https://i.redd.it/b7ytukjkj7va1.jpg',
    },
    {
      name: 'agnes demille',
      role: 'user',
      img: 'https://preview.redd.it/can-we-talk-about-this-look-of-agnes-demille-v0-3svuk3ccfymf1.jpeg?auto=webp&s=29ef456e0fb95b310c31ad737c4f7b5a87a5d806',
    },
    {
      name: 'tyler galpin',
      role: 'user',
      img: 'https://preview.redd.it/tyler-galpin-was-never-the-villain-v0-as23faxgwtze1.jpeg?auto=webp&s=c3b87bfd985633806125c23c20c83126f26d80f4',
    },
    {
      name: 'morticia addams',
      role: 'user',
      img: 'https://preview.redd.it/youre-a-brilliant-girl-wednesday-but-sometimes-you-get-in-v0-1ms0n4k914db1.png?auto=webp&s=aa329fdf796f63f4f0734c423d386eed4804177f',
    },
    {
      name: 'Jackson',
      role: 'user',
      img: 'https://images.unsplash.com/photo-1535713875002-d1d0cf377fde?ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxzZWFyY2h8Nnx8bWFsZSUyMHByb2ZpbGV8ZW58MHx8MHx8fDA%3D&fm=jpg&q=60&w=3000',
    },
    {
      name: 'James',
      role: 'user',
      img: 'https://media.istockphoto.com/id/1682296067/photo/happy-studio-portrait-or-professional-man-real-estate-agent-or-asian-businessman-smile-for.jpg?s=612x612&w=0&k=20&c=9zbG2-9fl741fbTWw5fNgcEEe4ll-JegrGlQQ6m54rg=',
    },
    {
      name: 'Mint',
      role: 'user',
      img: 'https://img.freepik.com/free-photo/portrait-sideways-woman-being-serious_23-2148255247.jpg?semt=ais_hybrid&w=740&q=80',
    },
    {
      name: 'Bella',
      role: 'user',
      img: 'https://c.stocksy.com/a/ynfA00/z9/2543982.jpg',
    },
    {
      name: 'momo',
      role: 'user',
      img: 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D&auto=format&fit=crop&q=80&w=1364',
      password: 'momo00000',
    },
    {
      name: 'adam',
      role: 'user',
      img: 'https://wallpapers.com/images/hd/woman-in-pink-backdrop-face-reference-xg14v8u3nczmnvgj.jpg',
      password: 'adam00000',
    },

  ];

  // ดึง id ของ user ตามชื่อ
  const ids = {};
  for (const u of users) {
    ids[u.name] = await upsertUser(u.name, u.role, u.img || null, u.password || null);
  }

  // ===== POSTS =====
  const base = '/uploads/posts/';
  const posts = [
    {
      user: 'taifoon',
      title: 'Jordan เสื้อยืดเด็กโต Legend Flight สีดำ ไซส์ L',
      desc: `ขายเสื้อยืด Jordan Legend Flight เด็กโต ไซส์ L 🏀  
      รุ่นนี้ใส่ง่าย เท่ทุกลุค ใครชอบแนวสตรีทห้ามพลาด!  
      ✅ สภาพสินค้า : มือสอง สภาพดีมาก ผ้านุ่ม ไม่มีรอยขาดหรือคราบ  
      ✅ วัสดุ : ผ้าฝ้ายแท้ ระบายอากาศดี ใส่สบาย  
      ✅ ดีไซน์ : สีดำพิมพ์ลาย Jumpman ชัด ใส่ได้ทั้งชายและหญิง  
      ✅ ความพิเศษ : รุ่นนี้หายากในไทยแล้วตอนนี้  
      📦 แพ็คให้เรียบร้อยก่อนส่ง  
      🚚 ส่งไวทั่วประเทศ (Flash, Kerry, J&T)`,
      price: 490,
      sell: true,
      trade: false,
      tags: ['เสื้อผ้า'],
      img: [
        'Jordan เสื้อยืด1.png',
        'Jordan เสื้อยืด2.png',
        'Jordan เสื้อยืด3.png',
        'Jordan เสื้อยืด4.png',
      ],
      promo: true,
    },
    {
      user: 'toey',
      title: 'กระเป๋าสะพายไหล่ Star Infinite Multi สีฟ้า',
      desc: `ขายกระเป๋าสะพายไหล่ Star Infinite Multi สีฟ้า 💙  
      รุ่นนี้ใช้งานน้อยมาก ยังดูใหม่ สายปรับได้ ใส่ของได้เยอะสุด ๆ ✨  
      ✅ สภาพสินค้า : มือสอง สภาพดี 90% ไม่มีรอยขาด ซิปใช้งานได้ปกติ  
      ✅ วัสดุ : หนังพียูคุณภาพดี ทำความสะอาดง่าย  
      ✅ ขนาด : 29 x 10.3 x 23 ซม. ใส่ของจุกจิกได้ครบ  
      ✅ จุดเด่น : ช่องเยอะ แยกของเป็นระเบียบ  
      ✅ ความพิเศษ : ฮาร์ดแวร์สีทอง ยังเงา ไม่ลอก  
      📦 แพ็คในถุงกันกระแทก  
      🚚 พร้อมส่งด่วนทั่วประเทศ`,
      price: null,
      sell: false,
      trade: true,
      tags: ['กระเป๋า'],
      special_tags: ['กระเป๋า'],
      img: [
        'กระเป๋าสะพายไหล่1.png',
        'กระเป๋าสะพายไหล่2.png',
        'กระเป๋าสะพายไหล่3.png',
        'กระเป๋าสะพายไหล่4.png',
      ],
      promo: false,
    },
    {
      user: 'pink',
      title: 'Nike ReactX Rejuven8 สีม่วง Size 39',
      desc: `ขาย Nike ReactX Rejuven8 สีม่วง Size 39 💜  
      ใส่ไปไม่เกิน 3 ครั้ง สภาพดีมาก กล่องเดิมยังอยู่ 👟  
      ✅ สภาพสินค้า : มือสอง ใช้งานน้อย ไม่มีตำหนิ พื้นสะอาด  
      ✅ วัสดุ : โฟม ReactX นุ่มเด้ง ใส่สบาย  
      ✅ จุดเด่น : ระบายอากาศดี น้ำหนักเบา  
      ✅ สีที่แสดง: Light Armory Blue/World Indigo/Light Armory Blue
      ✅ ความพิเศษ : รุ่นนี้หายาก ใส่เดินได้นานไม่เมื่อย  
      📦 มีกล่องเดิมให้  
      🚚 พร้อมจัดส่งทันทีทั่วไทย`,
      price: 1000,
      sell: true,
      trade: false,
      tags: ['รองเท้า'],
      img: [
        'Nike ReactX1.png',
        'Nike ReactX2.png',
        'Nike ReactX3.png',
        'Nike ReactX4.png',
      ],
      promo: true,
    },
    {
      user: 'candy',
      title: 'สร้อยคอ Celine Cœur Triomphe ',
      desc: `ขายสร้อยคอ Celine Cœur Triomphe 💛  
      ของแท้จาก Celine ใช้งานไปไม่กี่ครั้ง ยังดูใหม่มาก ✨  
      ✅ สภาพสินค้า : มือสอง สภาพดี 95% ไม่มีรอยดำหรือขาด  
      ✅ วัสดุ : ทองเหลือง ผ้าไหม และเรซิน  
      ✅ สี : ไอวอรี่ / กากี / น้ำตาล  
      ✅ ความพิเศษ : โลโก้ Celine ยังชัด ไม่ซีด  
      ✅ ดีไซน์ : สวมได้ทั้งแบบชั้นเดียวหรือสองชั้น  
      📦 พร้อมกล่องและถุงผ้าเดิม  
      🚚 ส่งฟรีทั่วประเทศ (EMS / Kerry)`,
      price: 550,
      sell: true,
      trade: true,
      tags: ['เครื่องประดับ'],
      special_tags: ['กระเป๋า'],
      img: [
        'สร้อยคอ Celine1.png',
        'สร้อยคอ Celine2.png',
        'สร้อยคอ Celine3.png',
        'สร้อยคอ Celine4.png',
      ],
      promo: true,
    },
    {
      user: 'focus',
      title: 'คีย์บอร์ดไร้สาย Keychron V1 Max รุ่น Retro',
      desc: `อยากเทรดคีย์บอร์ดไร้สาย WIRELESS KEYBOARD Keychron V1 Max QMK/VIA Gateron Jupiter Red Switch RGB EN/TH - Retro ⌨️  
      พิมพ์มันส์มาก เสียงนุ่ม ใช้งานน้อยสุด ๆ ✨  
      ✅ สภาพสินค้า : มือสอง ใช้งานไม่ถึงเดือน ไม่มีรอย  
      ✅ ฟีเจอร์ : ต่อได้ทั้งสาย, Bluetooth, 2.4GHz  
      ✅ สวิตช์ : Gateron Jupiter Red (Linear)  
      ✅ จุดเด่น : Hot-swap ได้ เปลี่ยนสวิตช์ง่าย  
      ✅ ความพิเศษ : คีย์แคปไทย-อังกฤษ ไฟ RGB เต็มระบบ  
      📦 มีกล่องและสายครบ  
      🚚 พร้อมเทรดกับของไอทีอื่น เช่น หูฟัง หรือเมาส์เกมมิ่ง`,
      price: null,
      sell: false,
      trade: true,
      tags: ['อุปกรณ์ไอที'],
      special_tags: ['อุปกรณ์ไอที'],
      img: [
        'WIRELESS KEYBOARD1.jpg',
        'WIRELESS KEYBOARD2.jpg',
        'WIRELESS KEYBOARD3.jpg',
        'WIRELESS KEYBOARD4.jpg',
        'WIRELESS KEYBOARD5.jpg',
        'WIRELESS KEYBOARD6.png',
      ],
      promo: false,
    },
    {
      user: 'gun',
      title: 'iPhone 17 Pro 1TB สี Navy Blue',
      desc: `ขาย iPhone 17 Pro 1TB สี Navy Blue 💙  
      ใช้งานมาแค่ 3 เดือน สภาพใหม่เอี่ยม ไม่มีรอยตกเลย ✨  
      ✅ สภาพสินค้า : มือสอง 98% ยังมีประกันศูนย์  
      ✅ ความจุ : 1TB ใช้งานลื่นทุกแอป  
      ✅ สี : น้ำเงินเข้ม Navy Blue  
      ✅ กล้อง : คมชัดระดับโปร ถ่ายกลางคืนดีมาก  
      ✅ ความพิเศษ : เครื่องศูนย์ไทย ของแท้ 100%  
      📦 มีกล่อง อุปกรณ์ครบ  
      🚚 ส่งฟรีทั่วประเทศ พร้อมประกันศูนย์เหลือ 9 เดือน`,
      price: 10000,
      sell: true,
      trade: false,
      tags: ['อิเล็กทรอนิกส์'],
      img: [
        'iPhone 17 Pro1.png',
        'iPhone 17 Pro2.png',
        'iPhone 17 Pro3.png',
        'iPhone 17 Pro4.png',
      ],
      promo: false,
    },
    {
      user: 'momo',
      title: 'กระเป๋าทรงโบว์ลิ่ง Blaise - สีดิสเทรสด์คอฟฟี่',
      desc: `กระเป๋าทรงโบว์ลิ่งจาก CHARLES & KEITH รุ่น Blaise สีดิสเทรสด์คอฟฟี่ ☕  
      ดีไซน์สวยคลาสสิก สายรัดหัวเข็มขัดคู่หน้าโดดเด่น พร้อมช่องเก็บของด้านข้างใช้งานสะดวก  
      ✅ วัสดุ : PU แบบมีรอยยับ สัมผัสหรูหรา  
      ✅ ช่องใส่ของ : 1 ช่องหลัก + 2 ช่องฝาปิดด้านนอก + 1 ช่องพับด้านใน  
      ✅ สายสะพาย : ถอดได้ / ปรับระดับได้ (ความยาว 111-123 ซม.)  
      ✅ หูจับสูง 8 ซม. สะดวกถือมือ  
      ✅ น้ำหนัก : 297 กรัม ขนาด 19 x 7 x 11.4 ซม.  
      ✅ ระบบปิด : ซิปเรียบหรู ใช้งานง่าย  
      📦 สภาพสินค้า : เคยทำตกน้ำครั้งเดียว...
      🚚 พร้อมส่งทั่วประเทศ`,
      price: 2790,
      sell: true,
      trade: false,
      tags: ['กระเป๋า'],
      img: [
        'กระเป๋าทรงโบว์ลิ่ง1.png',
        'กระเป๋าทรงโบว์ลิ่ง2.png',
        'กระเป๋าทรงโบว์ลิ่ง3.png',
        'กระเป๋าทรงโบว์ลิ่ง4.png',
      ],
      promo: false,
    },
    {
      user: 'adam',
      title: 'DYVLINGE ดีฟลิ้ง เก้าอี้พักผ่อนหมุนได้ สีดำ',
      desc: `เก้าอี้พักผ่อนหมุนได้รุ่น DYVLINGE จาก IKEA 🖤  
      เก้าอี้รุ่นตำนาน MILA ปี 1967 กลับมาอีกครั้งในคอลเลกชัน Nytillverkad  
      ✅ วัสดุ : ผ้าหุ้มโครงและผ้าบุ โพลีโพรพิลีน 100%  
      ✅ ฟังก์ชัน : หมุนได้ 360° นั่งสบาย รองรับหลังได้ดี  
      ✅ ขนาดกะทัดรัด เหมาะกับห้องนั่งเล่นหรือห้องนอน  
      ✅ ดีไซน์ร่วมสมัย พร้อมขาเหล็กโครเมียมเงา  
      📦 สภาพสินค้า : มือสองใช้งานน้อย มีครบที่เบาะเล็กน้อย 
      🚚 พร้อมจัดส่ง`,
      price: 2000,
      sell: true,
      trade: false,
      tags: ['บ้านและสวน'],
      img: [
        'เก้าอี้1.png',
        'เก้าอี้2.png',
        'เก้าอี้3.png',
        'เก้าอี้4.png',
        'เก้าอี้5.png',
      ],
      promo: false,
    },
    {
      user: 'momo',
      title: 'เต็นท์ทรงโดมเพื่อการเทรคกิ้งสำหรับ 2 คน รุ่น MT500',
      desc: `เต็นท์ทรงโดมรุ่น MT500 สำหรับการเทรคกิ้ง 2 คน ⛺  
      ระบายอากาศได้ดีเป็นพิเศษ เหมาะสำหรับอากาศร้อน  
      ✅ ออกแบบโดยทีมผู้เชี่ยวชาญการเดินป่า  
      ✅ ตั้งได้อย่างอิสระ มาพร้อมห้องนอนผ้าตาข่าย  
      ✅ ใช้โดยไม่ต้องติดตั้งฟลายชีตก็ได้ เพื่อค้างแรมชมดาว  
      ✅ ลดการเกิดหยดน้ำภายในและระบายอากาศดีเยี่ยม  
      ✅ โครงเต็นท์อะลูมิเนียมน้ำหนักเบา แข็งแรงทนทาน
      ✅ ใช้เต้นท์นี้ตั้งแคมป์ได้ในทุกสภาพอากาศ ไม่ว่าจะร้อน ชื้น หรือฝนตก
      📦 สภาพสินค้า : พร้อมใช้งาน มีรอยขาดเล็กน้อย
      🚚 พร้อมส่งทั่วไทย`,
      price: 3500,
      sell: true,
      trade: true,
      tags: ['อุปกรณ์กีฬา'],
      special_tags: ['อุปกรณ์กีฬา'],
      img: [
        'เต็นท์ทรงโดม1.png',
        'เต็นท์ทรงโดม2.png',
        'เต็นท์ทรงโดม3.png',
        'เต็นท์ทรงโดม4.png',
        'เต็นท์ทรงโดม5.png',
      ],
      promo: true,
    },
    {
      user: 'momo',
      title: 'ชุดอุปกรณ์สำหรับการตกปลา RESIFIGHT 100 COMPACT 2.40',
      desc: `ชุดอุปกรณ์ตกปลาครบเซ็ต RESIFIGHT 100 COMPACT 2.40 🎣  
      กะทัดรัดและอเนกประสงค์ เหมาะสำหรับตกปลานักล่าทุกประเภท  
      ✅ ขนาดพับเก็บเพียง 55 ซม. พกพาสะดวก  
      ✅ ใช้สำหรับตกปลาแบบถ่วงเหยื่อจมเป็นครั้งคราว  
      ✅ ทีมออกแบบผู้ชื่นชอบการตกปลาร่วมพัฒนา  
      ✅ มาพร้อมคันเบ็ดและรอกในชุดเดียว  
      📦 สภาพสินค้า : ใหม่ พร้อมใช้งาน  
      🚚 พร้อมส่งทั่วประเทศ`,
      price: 500,
      sell: true,
      trade: false,
      tags: ['อุปกรณ์กีฬา'],
      img: [
        'ตกปลา1.png',
        'ตกปลา2.png',
        'ตกปลา3.png',
        'ตกปลา4.png',
      ],
      promo: false,
    },
    {
      user: 'adam',
      title: 'เตาอบเล็กแมนนวล TOSHIBA ET-TD7080 (IV) 10 ลิตร',
      desc: `เตาอบเล็กแมนนวลจาก TOSHIBA ขนาด 10 ลิตร 🍞  
      มอบความอร่อยในขนาดกะทัดรัด สไตล์มินิมอล  
      ✅ ควบคุมด้วยลูกบิดหมุน ใช้งานง่าย  
      ✅ ตั้งเวลาได้สูงสุด 30 นาที  
      ✅ ปรับอุณหภูมิได้ 70-230°C  
      ✅ เหมาะสำหรับพื้นที่ขนาดเล็ก เคาน์เตอร์ครัวหรือหอพัก  
      ✅ ดีไซน์โทนสีงาช้าง เรียบหรู  
      ✅ ไม่กินไฟมาก ประหยัดพลังงาน 
      ✅ เล็ก เบา เคลื่อนย้ายสะดวก
      📦 สภาพสินค้า : ใช้งานมา 2 ปี ไม่ชำรุด
      🚚 ส่งด่วนทั่วประเทศ`,
      price: 1290,
      sell: true,
      trade: true,
      tags: ['เครื่องใช้ไฟฟ้า'],
      special_tags: ['อุปกรณ์ไอที'],
      img: [
        'เตาอบ1.png',
        'เตาอบ2.png',
        'เตาอบ3.png',
        'เตาอบ4.png',
        'เตาอบ5.png',
      ],
      promo: true,
    },
    {
      user: 'taifoon',
      title: 'Kanimal The Basket Tree ของเล่นแมว คอนโดแมว 5 ชั้น',
      desc: `คอนโดแมว Kanimal The Basket Tree รุ่นคลาสสิก 🐾  
      ขนาด XL (49x49x141 ซม.) เหมาะสำหรับแมว 2-3 ตัว  
      ✅ มีที่นอน 5 จุด รวมถึงจุดสูงสุดสำหรับชมวิว  
      ✅ เสาลับเล็บพันเชือกอย่างดี แข็งแรง  
      ✅ ฐานสี่เหลี่ยมมั่นคง เสถียร  
      ✅ มีของเล่นห้อยให้แมวตบเล่นสนุก 
      ✅ แมวจะชอบมาก ๆ เลย!
      ✅ นอนหลับสบายบนที่นอนนุ่ม ๆ
      📦 สภาพสินค้า : ใหม่เอี่ยม  
      🚚 พร้อมจัดส่งทั่วประเทศ`,
      price: 1500,
      sell: true,
      trade: true,
      tags: ['อุปกรณ์สัตว์เลี้ยง'],
      special_tags: ['บ้านและสวน'],
      img: [
        'คอนโด1.png',
        'คอนโด2.png',
        'คอนโด3.png',
        'คอนโด4.png',
      ],
      promo: false,
    },
    {
      user: 'gun',
      title: 'เสื้อฮู้ดตกแต่งไรน์สโตนสัญลักษณ์เมซง',
      desc: `เสื้อฮู้ดสุดหรูจากแบรนด์ชั้นนำ ✨  
      ดีไซน์ตกแต่งไรน์สโตนรูปอักษรย่อ LV ระยิบระยับ  
      ✅ วัสดุหลัก : คอตตอน 100% ซับในผ้าฟลีซนุ่ม  
      ✅ ทรงหลวม ใส่สบาย  
      ✅ สีเทาอ่อน ผลิตในอิตาลี  
      ✅ ดีเทลฮาร์ดแวร์สีทองหรูหรา  
      📦 สภาพสินค้า : ใหม่มาก  
      🚚 พร้อมส่งทั่วประเทศ`,
      price: 700,
      sell: false,
      trade: true,
      tags: ['เสื้อผ้า'],
      special_tags: ['กระเป๋า'],
      img: [
        'เสื้อฮู้ด1.png',
        'เสื้อฮู้ด2.png',
        'เสื้อฮู้ด3.png',
        'เสื้อฮู้ด4.png',
      ],
      promo: true,
    },
    {
      user: 'momo',
      title: 'โมเดลฟิกเกอร์ ตุ๊กตาชินจังนั่งสมาธิ',
      desc: `โมเดลฟิกเกอร์สุดน่ารัก "พระชินจัง" 🧘  
      ตกแต่งโต๊ะทำงานหรือชั้นวางได้เลย  
      ✅ วัสดุ : เรซินคุณภาพดี  
      ✅ ขนาดกะทัดรัด วางได้ทุกมุม  
      ✅ สีสันสดใส ดีเทลน่ารัก  
      📦 สภาพสินค้า : 99% เคยทำตกครั้งเดียว
      🚚 พร้อมส่งทั่วประเทศ`,
      price: 50,
      sell: true,
      trade: false,
      tags: ['ของสะสม'],
      img: [
        'ชินจัง1.png',
        'ชินจัง2.png',
        'ชินจัง3.png',
        'ชินจัง4.png',
      ],
      promo: false,
    },
    {
      user: 'adam',
      title: 'จักรยานเสือหมอบรุ่น RCR FORCE POWER (สีขาว/ดำ)',
      desc: `จักรยานเสือหมอบรุ่น RCR FORCE POWER 🚴‍♂️  
      รุ่นเรือธงที่ออกแบบโดยผู้เชี่ยวชาญด้านแอโรไดนามิกส์  
      ✅ เฟรมและตะเกียบคาร์บอน 100%  
      ✅ น้ำหนักเบาเพียง 7.7 กก. (ไซซ์ M)  
      ✅ ผ่านการทดสอบในอุโมงค์ลม  
      ✅ สมดุลระหว่างความเร็ว ความแข็งแรง และความสบาย  
      ✅ เหมาะสำหรับนักแข่งจริงจัง
      ✅ ใช้งานได้ทั้งถนนเรียบและทางขรุขระ  
      📦 สภาพสินค้า : ยังใช้การได้ มีประกัน  
      🚚 พร้อมส่งทั่วประเทศ`,
      price: 25000,
      sell: true,
      trade: true,
      tags: ['อุปกรณ์กีฬา'],
      special_tags: ['อุปกรณ์กีฬา'],
      img: [
        'จักรยาน1.png',
        'จักรยาน2.png',
        'จักรยาน3.png',
        'จักรยาน4.png',
      ],
      promo: true,
    },
    {
      user: 'focus',
      title: 'เสื้อพูลโอเวอร์ลาย Argyle สัญลักษณ์สามมิติ',
      desc: `เสื้อพูลโอเวอร์แคชเมียร์สุดหรู 💎  
      ลาย Argyle ผสานเทคนิคปัก Monogram แบบสามมิติ  
      ✅ วัสดุหลัก : แคชเมียร์ 100%  
      ✅ ลายปักสีพาสเทลสวยคลาสสิก  
      ✅ ผลิตในอิตาลี   
      ✅ คอวี ปลายแขนและขอบเอวแต่งริบลายทาง
      ✅ ใส่ได้ทั้งชายและหญิง
      ✅ ใส่แล้วดูดีมีสไตล์ รับประกันโดยคนขาย
      📦 สภาพสินค้า : มีคราบเล็กน้อย 70%
      🚚 พร้อมส่งทั่วประเทศ `,
      price: 700,
      sell: true,
      trade: true,
      tags: ['เสื้อผ้า'],
      special_tags: ['เครื่องประดับ'],
      img: [
        'เสื้อพูล1.png',
        'เสื้อพูล2.png',
        'เสื้อพูล3.png',
        'เสื้อพูล4.png',
      ],
      promo: false,
    },
  ];

  for (const p of posts) {
    await insertPostIfNotExists({
      user_id: ids[p.user],
      title: p.title,
      description: p.desc,
      price: p.price,
      is_sell: p.sell,
      is_trade: p.trade,
      tags: p.tags,
      special_tags:
        'special_tags' in p ? p.special_tags : p.trade ? ['ไม่สนใจเป็นพิเศษ'] : [],
      image_url: p.img.map((i) => base + i),
      status: 'approved',
      promoted: p.promo,
    });
  }

  // ===== SELLER REVIEWS =====
const reviews = [
  { reviewer: 'gun', seller: 'momo', rating: 5, comment: 'ของสภาพดี ส่งไวเหมือนเดิมเลยครับ 👍' },
  { reviewer: 'momo', seller: 'pink', rating: 4, comment: 'แพ็คของแน่นหนา คุณภาพตรงปกเลยค่ะ 💕' },
  { reviewer: 'pink', seller: 'adam', rating: 5, comment: 'บริการดีมากค่ะ ตอบไว เป็นกันเองสุด ๆ' },
  { reviewer: 'adam', seller: 'focus', rating: 2, comment: 'สินค้าตรงปกแต่ส่งช้านิดหน่อยครับ 🕒' },
  { reviewer: 'focus', seller: 'momo', rating: 4, comment: 'ได้ของครบ สภาพดีมาก ประทับใจค่ะ 🌸' },
  { reviewer: 'toey', seller: 'gun', rating: 5, comment: 'ราคาดี ของแท้แน่นอน แนะนำเลยครับ 🔥' },
  { reviewer: 'taifoon', seller: 'toey', rating: 4, comment: 'ส่งเร็ว ของดี มีของแถมด้วย 🛍️' },
  { reviewer: 'Bella', seller: 'momo', rating:3, comment: 'กล่องบุบไปหน่อย แต่ยังใช้งานได้ 😅' },
  { reviewer: 'momo', seller: 'candy', rating: 5, comment: 'น่ารักมาก ของหอม กล่องห่อดีมากค่ะ 🎁' },
  { reviewer: 'gun', seller: 'momo', rating: 4, comment: 'สินค้าคุณภาพดีเหมือนใหม่เลยครับ ⚡' },
  { reviewer: 'wednesday addams', seller: 'adam', rating: 5, comment: 'เทรดง่ายมากค่ะ คนขายใจดี ❤️' },
  { reviewer: 'Enid Sinclair', seller: 'taifoon', rating: 3, comment: 'ของดีแต่ส่งช้าหน่อย 😐' },
  { reviewer: 'Mint', seller: 'gun', rating: 5, comment: 'ส่งไวทันใจ สินค้าตรงปกมาก 🥰' },
  { reviewer: 'James', seller: 'candy', rating: 4, comment: 'คุณภาพสมราคาเลยครับ 👍' },
  { reviewer: 'Jackson', seller: 'adam', rating: 5, comment: 'ดีมากครับ ซื้อง่ายไม่ยุ่งยาก 💯' },
];

for (const r of reviews) {
  await query(
    `INSERT INTO seller_reviews (reviewer_id, seller_id, rating, comment, created_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (reviewer_id, seller_id) DO NOTHING`,
    [ids[r.reviewer], ids[r.seller], r.rating, r.comment]
  );
}

console.log("⭐ Seeded seller reviews");


  // ===== SEED COMMENTS (พร้อม guard) =====
  const postRows = await query(
    `SELECT id, user_id FROM posts ORDER BY id ASC LIMIT 6`
  );
  for (const post of postRows.rows) {
    await seedCommentsForPost(post.id, post.user_id, ids);
  }

  // ====================================
  // 🔔 SEED NOTIFICATIONS (เวอร์ชันแยก tokens ออก)
  // ====================================
  async function seedNotificationsForUser(userId) {
    const existing = await query(
      `SELECT COUNT(*) AS c FROM notifications WHERE user_id = $1`,
      [userId]
    );

    // ✅ ADD: ต่อให้มี noti แล้ว เราก็อยากให้มี noti โปรโมตอย่างน้อย 1 อัน
    const promoExisting = await query(
      `SELECT COUNT(*) AS c
       FROM notifications
       WHERE user_id = $1
         AND message LIKE 'โปรโมทโพสต์ % สำเร็จ!%'`,
      [userId]
    );
    if (Number(promoExisting.rows[0].c) === 0) {
      // ดึงโพสต์อีกรอบให้มี title
      const promoPosts = await query(
        `SELECT id, user_id, title FROM posts ORDER BY id ASC LIMIT 12`
      );
      await insertPromoteNotisForUser(userId, promoPosts.rows, 20);
    }
    // ✅ END ADD

    if (Number(existing.rows[0].c) > 0) {
      console.log(`⏭️  Skipped notifications for user ${userId} (already exists)`);
      return; // มี notification แล้ว ข้าม
    }

    const posts = await query(
      `SELECT id, user_id FROM posts ORDER BY id ASC LIMIT 6`
    );
    const now = new Date();

    const shopMessages = [
      'โพสต์ของคุณได้รับการอนุมัติและเผยแพร่แล้ว (หักโทเคน 10 tokens)',
      'โพสต์ของคุณถูกปฏิเสธ',
      'ผู้ซื้อได้ยืนยันการรับสินค้าแล้ว รอรีวิวจากผู้ซื้อ',
      'การเทรดยืนยันแล้ว กรุณาเตรียมส่งสินค้า',
      'สินค้าของคุณได้ถูกจัดส่งแล้ว',
      'ผู้รับยืนยันการจัดส่ง สถานะการเทรดเสร็จสมบูรณ์',
      'การเสนอการเทรดที่ตรงกับแท็กพิเศษของคุณถูกส่งไปแล้ว',
      'มีข้อเสนอการเทรดใหม่',
      'ข้อเสนอการเทรดของคุณถูกยอมรับแล้ว กรุณายืนยันเพื่อดำเนินการต่อ',
      'คุณได้รับรีวิวใหม่: 5 ดาว - ว้าว สินค้าสวยถูกใจมากจ้า',
    ];

    const orderMessages = [
      'การชำระเงินของคุณได้รับการยืนยันแล้ว รอผู้ขายจัดส่ง',
      'คำสั่งซื้อของคุณถูกจัดส่งแล้ว',
      'ซื้อ 100 tokens สำเร็จ',
      'ได้รับพัสดุแล้วใช่ไหม? กรุณากดยืนยันเพื่อรีวิวผู้ขาย',
      'การชำระเงินของคุณได้รับการยืนยันแล้ว รอผู้ขายจัดส่ง',
    ];

    for (let i = 0; i < 10; i++) {
      const randomPost =
        posts.rows[Math.floor(Math.random() * posts.rows.length)];
      const randomActorId = Math.floor(Math.random() * 10) + 1;

      // แท็บ "ร้านค้าของฉัน"
      await insertNotification(
        userId,
        shopMessages[i % shopMessages.length],
        new Date(now.getTime() - i * 60 * 60 * 1000),
        randomPost.id,
        randomActorId
      );

      // แท็บ "คำสั่งซื้อของฉัน"
      if (i < 10) {
        const msg = orderMessages[i % orderMessages.length];
        const createdAt = new Date(
          now.getTime() - (i + 10) * 60 * 60 * 1000
        );

        // ❗ ถ้าเป็น tokens สำเร็จ → อย่าใส่ post_id / actor_id
        if (msg.includes('tokens สำเร็จ')) {
          await insertNotification(userId, msg, createdAt);
        } else {
          await insertNotification(
            userId,
            msg,
            createdAt,
            randomPost.id,
            randomPost.user_id
          );
        }
      }
    }
  }

  const allUsers = await query(`SELECT id, username FROM users`);
  for (const u of allUsers.rows) {
    await seedNotificationsForUser(u.id);
    console.log(`📩 Seeded notifications for ${u.username}`);
  }

  console.log('✅ Seed completed successfully!');
}

run()
  .catch(console.error)
  .finally(() => pool.end());
