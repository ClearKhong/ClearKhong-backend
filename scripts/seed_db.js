import bcrypt from 'bcryptjs';
import { query, pool } from '../src/db.js';

const IMG =
  'https://www.apple.com/v/iphone/home/cc/images/overview/consider_modals/environment/modal_trade_in_variant__ejij0q8th06e_large.jpg';

async function upsertUser(username, role = 'user') {
  const hash = await bcrypt.hash(username, 10);
  const inserted = await query(
    `INSERT INTO users (username, password_hash, role, tokens, is_active)
     VALUES ($1, $2, $3, 100, true)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [username, hash, role]
  );
  if (inserted.rows.length)
    return inserted.rows[0].id;
  const r = await query('SELECT id FROM users WHERE username=$1', [username]);
  return r.rows[0].id;
}

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
      p.promoted || false
    ]
  );
}

async function run() {
  const users = [
    { name: 'admin', role: 'admin' },
    { name: 'taifoon', role: 'user' },
    { name: 'gun', role: 'user' },
    { name: 'focus', role: 'user' },
    { name: 'toey', role: 'user' },
    { name: 'candy', role: 'user' },
    { name: 'pink', role: 'user' },
  ];

  const ids = {};
  for (const u of users) ids[u.name] = await upsertUser(u.name, u.role);
  //   { user_id: ids['alice'],   title: 'Vintage Camera',     description: 'Great condition', price: 1200, is_sell: true,  is_trade: false, tags: ['electronics'], status: 'approved' },

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
      img: ['Jordan เสื้อยืด1.png','Jordan เสื้อยืด2.png','Jordan เสื้อยืด3.png','Jordan เสื้อยืด4.png'],
      promo: true
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
      img: ['กระเป๋าสะพายไหล่1.png','กระเป๋าสะพายไหล่2.png','กระเป๋าสะพายไหล่3.png','กระเป๋าสะพายไหล่4.png'],
      promo: false
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
      img: ['Nike ReactX1.png','Nike ReactX2.png','Nike ReactX3.png','Nike ReactX4.png'],
      promo: false
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
      img: ['สร้อยคอ Celine1.png','สร้อยคอ Celine2.png','สร้อยคอ Celine3.png','สร้อยคอ Celine4.png'],
      promo: true
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
      img: ['WIRELESS KEYBOARD1.jpg','WIRELESS KEYBOARD2.jpg','WIRELESS KEYBOARD3.jpg','WIRELESS KEYBOARD4.jpg','WIRELESS KEYBOARD5.jpg','WIRELESS KEYBOARD6.png'],
      promo: false
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
      img: ['iPhone 17 Pro1.png','iPhone 17 Pro2.png','iPhone 17 Pro3.png','iPhone 17 Pro4.png'],
      promo: false
    }
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
      special_tags: ('special_tags' in p)
      ? p.special_tags
      : (p.trade ? ['tradeable'] : []), 
      image_url: p.img.map(i => base + i),
      status: 'approved',
      promoted: p.promo
    });
  }

  console.log('✅ Seeded database');
}

run().catch(console.error).finally(() => pool.end());