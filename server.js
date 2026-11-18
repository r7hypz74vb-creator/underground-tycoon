import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import crypto from 'node:crypto';
import pg from 'pg';
dotenv.config();

const app=express();
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL});
app.use(cors({origin:process.env.WEBAPP_URL}));
app.use(express.json({limit:'64kb'}));

const PACKS={
  starter:{title:'Стартовый набор',stars:50,coins:2500,items:1},
  pro:{title:'Набор предпринимателя',stars:150,coins:9000,items:3},
  elite:{title:'Набор магната',stars:350,coins:25000,items:8}
};

function verifyInitData(initData){
  if(!process.env.BOT_TOKEN||!initData)return null;
  const p=new URLSearchParams(initData),hash=p.get('hash');if(!hash)return null;p.delete('hash');
  const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');
  const secret=crypto.createHmac('sha256','WebAppData').update(process.env.BOT_TOKEN).digest();
  const calculated=crypto.createHmac('sha256',secret).update(check).digest('hex');
  if(!/^[a-f0-9]{64}$/i.test(hash)||!crypto.timingSafeEqual(Buffer.from(hash,'hex'),Buffer.from(calculated,'hex')))return null;
  const authDate=Number(p.get('auth_date'));if(!authDate||Date.now()/1000-authDate>86400)return null;
  try{return {...JSON.parse(p.get('user')||'{}'),start_param:p.get('start_param')||''}}catch{return null}
}
async function auth(req,res,next){
  const user=verifyInitData(req.header('x-telegram-init-data'));
  if(!user?.id)return res.status(401).json({error:'Недействительная сессия Telegram'});
  req.user=user;next();
}
async function botApi(method,body){
  const r=await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)
  });
  const data=await r.json();if(!data.ok)throw new Error(data.description||'Telegram API error');return data.result;
}
function safeInt(v){return Number.isSafeInteger(Number(v))?Number(v):null;}
async function attachReferral(client,inviteeId,startParam){
  const m=/^ref_(\d+)$/.exec(startParam||'');if(!m)return false;
  const inviterId=safeInt(m[1]);if(!inviterId||inviterId===Number(inviteeId))return false;
  const inviter=await client.query('SELECT telegram_id FROM players WHERE telegram_id=$1',[inviterId]);
  if(!inviter.rowCount)return false;
  const assigned=await client.query('UPDATE players SET referred_by=$1 WHERE telegram_id=$2 AND referred_by IS NULL',[inviterId,inviteeId]);
  if(!assigned.rowCount)return false;
  await client.query('INSERT INTO referrals(inviter_id,invitee_id) VALUES($1,$2) ON CONFLICT(invitee_id) DO NOTHING',[inviterId,inviteeId]);
  return true;
}
async function rewardReferralIfEligible(client,inviteeId,level){
  if(level<3)return;
  const q=await client.query(`SELECT id,inviter_id FROM referrals WHERE invitee_id=$1 AND rewarded=FALSE FOR UPDATE`,[inviteeId]);
  if(!q.rowCount)return;
  const ref=q.rows[0];
  await client.query('UPDATE players SET coins=coins+500,earned=earned+500 WHERE telegram_id=$1',[ref.inviter_id]);
  await client.query('UPDATE players SET coins=coins+500,earned=earned+500 WHERE telegram_id=$1',[inviteeId]);
  await client.query('UPDATE referrals SET rewarded=TRUE WHERE id=$1',[ref.id]);
}

app.get('/health',(_,res)=>res.json({ok:true}));
app.post('/api/session',auth,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const q=await c.query(`INSERT INTO players(telegram_id,username) VALUES($1,$2)
      ON CONFLICT(telegram_id) DO UPDATE SET username=EXCLUDED.username
      RETURNING telegram_id,coins,xp,level,business_level,prestige,reputation,earned`,
      [req.user.id,req.user.username||null]);
    await attachReferral(c,req.user.id,req.user.start_param);
    await rewardReferralIfEligible(c,req.user.id,q.rows[0].level);
    await c.query('COMMIT');res.json(q.rows[0]);
  }catch(e){await c.query('ROLLBACK');res.status(500).json({error:'Не удалось создать сессию'});}
  finally{c.release();}
});
app.get('/api/state',auth,async(req,res)=>{
  const [p,items]=await Promise.all([
    pool.query('SELECT telegram_id,coins,xp,level,business_level,prestige,reputation,earned FROM players WHERE telegram_id=$1',[req.user.id]),
    pool.query('SELECT id,item_key,item_name,rarity,value FROM inventory WHERE telegram_id=$1 ORDER BY id DESC',[req.user.id])
  ]);
  res.json({player:p.rows[0],inventory:items.rows});
});

// Server-authoritative work action, including XP/level progression and referral milestone.
app.post('/api/work',auth,async(req,res)=>{
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const q=await c.query('SELECT * FROM players WHERE telegram_id=$1 FOR UPDATE',[req.user.id]);
    if(!q.rowCount)throw new Error('Player not initialized');
    const p=q.rows[0],gain=15+p.business_level*3+p.prestige*2;
    let xp=p.xp+12,level=p.level;
    while(xp>=level*100&&level<100){xp-=level*100;level++;}
    const updated=await c.query(`UPDATE players SET coins=coins+$2,earned=earned+$2,xp=$3,level=$4,reputation=reputation+10
      WHERE telegram_id=$1 RETURNING coins,xp,level,earned`,[req.user.id,gain,xp,level]);
    await rewardReferralIfEligible(c,req.user.id,level);
    await c.query('COMMIT');res.json({...updated.rows[0],gained:gain});
  }catch(e){await c.query('ROLLBACK');res.status(400).json({error:'Действие не выполнено'});}
  finally{c.release();}
});

app.get('/api/referrals',auth,async(req,res)=>{
  const q=await pool.query(`SELECT COUNT(*)::int AS invited,
    COUNT(*) FILTER (WHERE rewarded=TRUE)::int AS rewarded
    FROM referrals WHERE inviter_id=$1`,[req.user.id]);
  res.json(q.rows[0]);
});

// Create an item listing atomically: item leaves inventory and becomes a market lot.
app.post('/api/market/list',auth,async(req,res)=>{
  const itemId=safeInt(req.body.itemId),price=safeInt(req.body.price);
  if(!itemId||!price||price<1||price>100000000)return res.status(400).json({error:'Проверь предмет и цену'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const item=await c.query('DELETE FROM inventory WHERE id=$1 AND telegram_id=$2 RETURNING id,item_key,item_name,rarity,value',[itemId,req.user.id]);
    if(!item.rowCount)throw new Error('Предмет не найден');
    const ins=await c.query(`INSERT INTO marketplace(seller_id,item_id,price,item_snapshot,status)
      VALUES($1,$2,$3,$4,'active') RETURNING id,price`,[req.user.id,itemId,price,JSON.stringify(item.rows[0])]);
    await c.query('COMMIT');res.json({ok:true,listing:ins.rows[0]});
  }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}
  finally{c.release();}
});
app.get('/api/market',auth,async(req,res)=>{
  const q=await pool.query(`SELECT m.id,m.seller_id,m.price,m.created_at,m.item_snapshot,
    p.username AS seller_name FROM marketplace m JOIN players p ON p.telegram_id=m.seller_id
    WHERE m.status='active' ORDER BY m.created_at DESC LIMIT 100`);
  res.json({listings:q.rows});
});
app.post('/api/market/buy',auth,async(req,res)=>{
  const listingId=safeInt(req.body.listingId);if(!listingId)return res.status(400).json({error:'Некорректный лот'});
  const c=await pool.connect();
  try{
    await c.query('BEGIN');
    const l=await c.query(`SELECT * FROM marketplace WHERE id=$1 AND status='active' FOR UPDATE`,[listingId]);
    if(!l.rowCount)throw new Error('Лот уже продан или снят');
    const lot=l.rows[0];if(String(lot.seller_id)===String(req.user.id))throw new Error('Нельзя купить собственный лот');
    const buyer=await c.query('UPDATE players SET coins=coins-$2 WHERE telegram_id=$1 AND coins >= $2 RETURNING telegram_id',[req.user.id,lot.price]);
    if(!buyer.rowCount)throw new Error('Недостаточно монет');
    const snapshot=typeof lot.item_snapshot==='string'?JSON.parse(lot.item_snapshot):lot.item_snapshot;
    await c.query(`INSERT INTO inventory(telegram_id,item_key,item_name,rarity,value) VALUES($1,$2,$3,$4,$5)`,
      [req.user.id,snapshot.item_key||'market-item',snapshot.item_name,snapshot.rarity,snapshot.value]);
    await c.query('UPDATE players SET coins=coins+$2,earned=earned+$2 WHERE telegram_id=$1',[lot.seller_id,lot.price]);
    await c.query("UPDATE marketplace SET status='sold' WHERE id=$1",[listingId]);
    await c.query('COMMIT');res.json({ok:true});
  }catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}
  finally{c.release();}
});

// Telegram Stars packs: prices/products are defined on the server, never by the client.
app.get('/api/stars/packs',auth,(_,res)=>res.json({packs:Object.entries(PACKS).map(([key,p])=>({key,title:p.title,stars:p.stars,coins:p.coins}))}));
app.post('/api/stars/invoice',auth,async(req,res)=>{
  const key=req.body.packKey,pack=PACKS[key];if(!pack)return res.status(400).json({error:'Неизвестный набор'});
  try{
    const payload=`ut:${req.user.id}:${key}:${crypto.randomUUID()}`;
    const url=await botApi('createInvoiceLink',{
      title:pack.title,description:`Игровой набор UNDERGROUND TYCOON: ${pack.coins} монет`,
      payload,currency:'XTR',prices:[{label:pack.title,amount:pack.stars}]
    });
    res.json({invoiceUrl:url});
  }catch(e){res.status(502).json({error:'Не удалось создать счёт Telegram Stars'});}
});

// Configure this URL as the bot webhook. Fulfil only on Telegram successful_payment.
app.post('/telegram/webhook',async(req,res)=>{
  if(process.env.WEBHOOK_SECRET&&req.header('x-telegram-bot-api-secret-token')!==process.env.WEBHOOK_SECRET)
    return res.sendStatus(401);
  const update=req.body;
  try{
    if(update.pre_checkout_query){
      const q=update.pre_checkout_query;
      const parts=(q.invoice_payload||'').split(':');
      const pack=PACKS[parts[2]];
      const valid=parts[0]==='ut'&&pack&&q.currency==='XTR'&&q.total_amount===pack.stars&&String(parts[1])===String(q.from.id);
      await botApi('answerPreCheckoutQuery',{pre_checkout_query_id:q.id,ok:!!valid,...(!valid?{error_message:'Счёт недействителен'}:{})});
    }
    const msg=update.message,sp=msg?.successful_payment;
    if(sp){
      const parts=(sp.invoice_payload||'').split(':'),telegramId=safeInt(parts[1]),key=parts[2],pack=PACKS[key];
      if(parts[0]==='ut'&&telegramId&&pack&&String(msg.from.id)===String(telegramId)&&sp.currency==='XTR'&&sp.total_amount===pack.stars){
        const c=await pool.connect();
        try{
          await c.query('BEGIN');
          const inserted=await c.query(`INSERT INTO payment_events(telegram_charge_id,telegram_id,product_key,stars)
            VALUES($1,$2,$3,$4) ON CONFLICT(telegram_charge_id) DO NOTHING RETURNING telegram_charge_id`,
            [sp.telegram_payment_charge_id,telegramId,key,sp.total_amount]);
          if(inserted.rowCount)await c.query('UPDATE players SET coins=coins+$2,earned=earned+$2 WHERE telegram_id=$1',[telegramId,pack.coins]);
          await c.query('COMMIT');
        }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
      }
    }
    res.sendStatus(200);
  }catch(e){res.sendStatus(500);}
});

app.listen(process.env.PORT||3000,()=>console.log('UNDERGROUND TYCOON API listening'));
