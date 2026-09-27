/* Vérifie la gestion des provocations depuis le panel admin :
   création payante, création gratuite (offerte à tous), suppression propre. */
const BASE='http://localhost:3000';
async function reg(pseudo){
  const r=await fetch(BASE+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pseudo,password:'test1234'})});
  const d=await r.json();
  return {cookie:r.headers.getSetCookie().find(c=>c.startsWith('connect.sid')).split(';')[0], profile:d.profile};
}
function mk(cookie){return async(p,m,b)=>{const r=await fetch(BASE+p,{method:m||'GET',headers:Object.assign({Cookie:cookie},b?{'Content-Type':'application/json'}:{}),body:b?JSON.stringify(b):undefined});return{ok:r.ok,d:await r.json().catch(()=>({}))};};}

(async()=>{
  let fails=0;
  const A=await reg('AdminEmoteA_'+Date.now().toString(36));
  const rA=mk(A.cookie);
  const before=(await rA('/api/config')).d.emotes.length;
  console.log('Provocations au départ :', before);

  // 1) Création d'une provocation payante
  const c1=await rA('/api/admin/emotes','POST',{code:'admin123',text:'Tu vas regretter ce tour.',price:200,tone:'piquant'});
  console.log(c1.ok?'✅ Provocation payante créée : "'+c1.d.emote.text+'" ('+c1.d.emote.price+' ✧)':'❌ '+c1.d.error);
  if(!c1.ok) fails++;

  // Elle apparaît dans la boutique mais n'est pas encore possédée
  const shop=(await rA('/api/shop')).d;
  const inShop=shop.emotes.some(e=>e.id===c1.d.emote.id);
  const ownedAlready=shop.ownedEmotes.includes(c1.d.emote.id);
  console.log(inShop?'✅ Visible en boutique':'❌ absente de la boutique'); if(!inShop) fails++;
  console.log(!ownedAlready?'✅ Non débloquée tant qu\'elle n\'est pas achetée':'❌ offerte à tort'); if(ownedAlready) fails++;

  // 2) Création d'une provocation gratuite → offerte à tous immédiatement
  const c2=await rA('/api/admin/emotes','POST',{code:'admin123',text:'Belle partie !',price:0,tone:'amical'});
  console.log(c2.ok?'✅ Provocation gratuite créée':'❌ '+c2.d.error); if(!c2.ok) fails++;
  const me=(await rA('/api/me')).d.profile;
  const gotFree=me.ownedEmotes.includes(c2.d.emote.id);
  console.log(gotFree?'✅ Provocation gratuite automatiquement débloquée pour les joueurs existants':'❌ non offerte'); if(!gotFree) fails++;

  // 3) Mauvais code admin refusé
  const bad=await rA('/api/admin/emotes','POST',{code:'faux',text:'Pirate',price:0});
  console.log(bad.ok?'❌ mauvais code accepté':'✅ mauvais code admin refusé'); if(bad.ok) fails++;

  // 4) Doublon refusé
  const dup=await rA('/api/admin/emotes','POST',{code:'admin123',text:'Belle partie !',price:50});
  console.log(dup.ok?'❌ doublon accepté':'✅ texte en double refusé'); if(dup.ok) fails++;

  // 5) Texte vide refusé
  const empty=await rA('/api/admin/emotes','POST',{code:'admin123',text:'   ',price:10});
  console.log(empty.ok?'❌ texte vide accepté':'✅ texte vide refusé'); if(empty.ok) fails++;

  // 6) La nouvelle gratuite peut être placée dans la roue
  const wheel=[c2.d.emote.id,'salut','gg','oups','merci','menace'];
  const sw=await rA('/api/me/emote-wheel','POST',{wheel});
  console.log(sw.ok?'✅ Provocation admin plaçable dans la roue':'❌ '+sw.d.error); if(!sw.ok) fails++;

  // 7) Suppression : retirée de la boutique ET de la roue du joueur
  const del=await fetch(BASE+'/api/admin/emotes/'+c2.d.emote.id,{method:'DELETE',headers:{Cookie:A.cookie,'Content-Type':'application/json'},body:JSON.stringify({code:'admin123'})});
  console.log(del.ok?'✅ Suppression acceptée':'❌ suppression refusée'); if(!del.ok) fails++;
  const after=(await rA('/api/me')).d.profile;
  const stillOwned=after.ownedEmotes.includes(c2.d.emote.id);
  const stillWheel=after.emoteWheel.includes(c2.d.emote.id);
  console.log(!stillOwned?'✅ Retirée des provocations possédées':'❌ encore possédée'); if(stillOwned) fails++;
  console.log(!stillWheel?'✅ Retirée de la roue du joueur':'❌ encore dans la roue'); if(stillWheel) fails++;
  console.log(after.emoteWheel.length===6?'✅ Roue recomplétée automatiquement à 6 ('+after.emoteWheel.join(', ')+')':'❌ roue à '+after.emoteWheel.length+' emplacements'); 
  if(after.emoteWheel.length!==6) fails++;

  console.log(fails===0?'\n✅ Gestion admin des provocations validée.':'\n❌ '+fails+' échec(s)');
  process.exit(fails===0?0:1);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
