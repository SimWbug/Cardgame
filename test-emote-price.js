/* Vérifie la modification du prix des provocations depuis le panel admin. */
const BASE='http://localhost:3000';
async function reg(p){const r=await fetch(BASE+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pseudo:p,password:'test1234'})});const d=await r.json();return{cookie:r.headers.getSetCookie().find(c=>c.startsWith('connect.sid')).split(';')[0],profile:d.profile};}
function mk(c){return async(p,m,b)=>{const r=await fetch(BASE+p,{method:m||'GET',headers:Object.assign({Cookie:c},b?{'Content-Type':'application/json'}:{}),body:b?JSON.stringify(b):undefined});return{ok:r.ok,d:await r.json().catch(()=>({}))};};}
const patch=(cookie,id,body)=>fetch(BASE+'/api/admin/emotes/'+id,{method:'PATCH',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)}).then(async r=>({ok:r.ok,d:await r.json().catch(()=>({}))}));

(async()=>{
  let fails=0;
  const sfx=Date.now().toString(36);
  const A=await reg('PriceAdmin_'+sfx);
  const B=await reg('PriceUser_'+sfx);
  const rA=mk(A.cookie), rB=mk(B.cookie);

  const ez=(await rA('/api/config')).d.emotes.find(e=>e.id==='ez');
  console.log('Prix initial de "ez" :', ez.price, '✧');

  const up=await patch(A.cookie,'ez',{code:'admin123',price:250});
  console.log(up.ok?'✅ Prix modifié → '+up.d.emote.price+' ✧':'❌ '+up.d.error); if(!up.ok) fails++;
  const check=(await rA('/api/config')).d.emotes.find(e=>e.id==='ez');
  console.log(check.price===250?'✅ Nouveau prix persisté':'❌ prix non persisté ('+check.price+')'); if(check.price!==250) fails++;

  const shopB=(await rB('/api/shop')).d;
  const ezShop=shopB.emotes.find(e=>e.id==='ez');
  console.log(ezShop.price===250?'✅ Boutique affiche bien 250 ✧':'❌ boutique désynchronisée'); if(ezShop.price!==250) fails++;
  const buyFail=await rB('/api/shop/buy-emote','POST',{emoteId:'ez'});
  const msgOk=!buyFail.ok && buyFail.d.error.includes('250');
  console.log(msgOk?'✅ Achat refusé au nouveau tarif ('+buyFail.d.error+')':'❌ '+(buyFail.ok?'achat accepté':'message inattendu : '+buyFail.d.error));
  if(!msgOk) fails++;

  const neg=await patch(A.cookie,'ez',{code:'admin123',price:-10});
  console.log(neg.ok?'❌ prix négatif accepté':'✅ prix négatif refusé'); if(neg.ok) fails++;

  const bad=await patch(A.cookie,'ez',{code:'faux',price:1});
  console.log(bad.ok?'❌ mauvais code accepté':'✅ mauvais code admin refusé'); if(bad.ok) fails++;

  const free=await patch(A.cookie,'ez',{code:'admin123',price:0});
  console.log(free.ok?'✅ "ez" passée en gratuite':'❌ '+free.d.error); if(!free.ok) fails++;
  const meB=(await rB('/api/me')).d.profile;
  const got=meB.ownedEmotes.includes('ez');
  console.log(got?'✅ Débloquée automatiquement chez les joueurs existants':'❌ non offerte'); if(!got) fails++;

  const paid=await patch(A.cookie,'ez',{code:'admin123',price:500});
  console.log(paid.ok?'✅ Repassée à 500 ✧':'❌ '+paid.d.error); if(!paid.ok) fails++;
  const meB2=(await rB('/api/me')).d.profile;
  const kept=meB2.ownedEmotes.includes('ez');
  console.log(kept?'✅ Le joueur qui la possédait la conserve':'❌ retirée à tort'); if(!kept) fails++;

  const nf=await patch(A.cookie,'inexistante',{code:'admin123',price:10});
  console.log(nf.ok?'❌ id inconnu accepté':'✅ provocation inconnue refusée'); if(nf.ok) fails++;

  console.log(fails===0?'\n✅ Modification des prix validée.':'\n❌ '+fails+' échec(s)');
  process.exit(fails===0?0:1);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
