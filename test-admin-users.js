/* Vérifie la gestion des comptes depuis le panel admin :
   liste, consultation de collection, reset mot de passe, ajustement de
   poussière, suppression (avec confirmation par pseudo). */
const BASE='http://localhost:3000';
async function reg(p){const r=await fetch(BASE+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pseudo:p,password:'test1234'})});const d=await r.json();return{cookie:r.headers.getSetCookie().find(c=>c.startsWith('connect.sid')).split(';')[0],profile:d.profile};}
function mk(c){return async(p,m,b)=>{const r=await fetch(BASE+p,{method:m||'GET',headers:Object.assign({Cookie:c},b?{'Content-Type':'application/json'}:{}),body:b?JSON.stringify(b):undefined});return{ok:r.ok,d:await r.json().catch(()=>({}))};};}

(async()=>{
  let fails=0;
  const sfx=Date.now().toString(36);
  const admin=await reg('UserAdmin_'+sfx);
  const target=await reg('UserTarget_'+sfx);
  const rA=mk(admin.cookie), rT=mk(target.cookie);

  // 1) Liste des comptes
  const list=await rA('/api/admin/users','POST',{code:'admin123'});
  console.log(list.ok?'✅ Liste des comptes récupérée ('+list.d.users.length+' comptes)':'❌ '+list.d.error);
  if(!list.ok) fails++;
  const found=list.d.users.find(u=>u.slug===target.profile.slug);
  console.log(found?'✅ Le compte cible apparaît dans la liste':'❌ absent de la liste'); if(!found) fails++;

  // 2) Mauvais code refusé
  const bad=await rA('/api/admin/users','POST',{code:'faux'});
  console.log(bad.ok?'❌ mauvais code accepté':'✅ mauvais code admin refusé'); if(bad.ok) fails++;

  // 3) Consultation de la collection
  const coll=await rA('/api/admin/users/'+target.profile.slug+'/collection','POST',{code:'admin123'});
  console.log(coll.ok && coll.d.collection?'✅ Collection consultable ('+Object.keys(coll.d.collection).length+' types de cartes)':'❌ '+coll.d.error);
  if(!coll.ok) fails++;

  // 4) Ajustement de poussière : +200 puis -50
  const before=(await rT('/api/me')).d.profile.dust;
  const add=await rA('/api/admin/users/'+target.profile.slug+'/dust','POST',{code:'admin123',delta:200});
  console.log(add.ok && add.d.dust===before+200?'✅ +200 poussière appliqué ('+add.d.dust+')':'❌ ajout de poussière incorrect');
  if(!add.ok || add.d.dust!==before+200) fails++;
  const sub=await rA('/api/admin/users/'+target.profile.slug+'/dust','POST',{code:'admin123',delta:-50});
  console.log(sub.ok && sub.d.dust===before+150?'✅ -50 poussière appliqué ('+sub.d.dust+')':'❌ retrait de poussière incorrect');
  if(!sub.ok || sub.d.dust!==before+150) fails++;
  // Ne doit jamais descendre sous 0
  const neg=await rA('/api/admin/users/'+target.profile.slug+'/dust','POST',{code:'admin123',delta:-999999});
  console.log(neg.ok && neg.d.dust===0?'✅ La poussière est plafonnée à 0, jamais négative':'❌ poussière négative possible ('+neg.d.dust+')');
  if(!neg.ok || neg.d.dust<0) fails++;

  // 4bis) Ajustement de crédits : même logique que la poussière
  const creditsBefore=(await rT('/api/me')).d.profile.credits;
  const addC=await rA('/api/admin/users/'+target.profile.slug+'/credits','POST',{code:'admin123',delta:300});
  console.log(addC.ok && addC.d.credits===creditsBefore+300?'✅ +300 crédits appliqué ('+addC.d.credits+')':'❌ ajout de crédits incorrect');
  if(!addC.ok || addC.d.credits!==creditsBefore+300) fails++;
  const subC=await rA('/api/admin/users/'+target.profile.slug+'/credits','POST',{code:'admin123',delta:-100});
  console.log(subC.ok && subC.d.credits===creditsBefore+200?'✅ -100 crédits appliqué ('+subC.d.credits+')':'❌ retrait de crédits incorrect');
  if(!subC.ok || subC.d.credits!==creditsBefore+200) fails++;
  const negC=await rA('/api/admin/users/'+target.profile.slug+'/credits','POST',{code:'admin123',delta:-999999});
  console.log(negC.ok && negC.d.credits===0?'✅ Les crédits sont plafonnés à 0, jamais négatifs':'❌ crédits négatifs possibles ('+negC.d.credits+')');
  if(!negC.ok || negC.d.credits<0) fails++;
  const badCodeC=await rA('/api/admin/users/'+target.profile.slug+'/credits','POST',{code:'faux',delta:100});
  console.log(!badCodeC.ok?'✅ Ajustement de crédits refusé avec un mauvais code':'❌ accepté à tort');
  if(badCodeC.ok) fails++;

  // 5) Réinitialisation du mot de passe oublié
  const reset=await rA('/api/admin/users/'+target.profile.slug+'/reset-password','POST',{code:'admin123',newPassword:'nouveauMdp123'});
  console.log(reset.ok?'✅ Mot de passe réinitialisé':'❌ '+reset.d.error); if(!reset.ok) fails++;
  const oldLogin=await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pseudo:target.profile.pseudo,password:'test1234'})});
  console.log(!oldLogin.ok?'✅ L\'ancien mot de passe ne fonctionne plus':'❌ ancien mot de passe encore valide'); if(oldLogin.ok) fails++;
  const newLogin=await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pseudo:target.profile.pseudo,password:'nouveauMdp123'})});
  console.log(newLogin.ok?'✅ Le nouveau mot de passe fonctionne':'❌ nouveau mot de passe refusé'); if(!newLogin.ok) fails++;

  // 6) Mot de passe trop court refusé
  const short=await rA('/api/admin/users/'+target.profile.slug+'/reset-password','POST',{code:'admin123',newPassword:'ab'});
  console.log(short.ok?'❌ mot de passe trop court accepté':'✅ mot de passe trop court refusé'); if(short.ok) fails++;

  // 7) Suppression sans confirmation refusée
  const noConfirm=await rA('/api/admin/users/'+target.profile.slug+'/delete','POST',{code:'admin123'});
  console.log(noConfirm.ok?'❌ suppression sans confirmation acceptée':'✅ suppression sans confirmation refusée'); if(noConfirm.ok) fails++;

  // 8) Amitié réciproque nettoyée à la suppression
  await rA('/api/players/'+target.profile.slug+'/friend','POST');
  const meBefore=(await rA('/api/me')).d.profile;
  console.log(meBefore.friends.includes(target.profile.slug)?'✅ Ami ajouté avant suppression (préparation du test)':'❌ ami non ajouté');

  // 9) Suppression avec confirmation correcte
  const del=await rA('/api/admin/users/'+target.profile.slug+'/delete','POST',{code:'admin123',confirmPseudo:target.profile.pseudo});
  console.log(del.ok?'✅ Compte supprimé':'❌ '+del.d.error); if(!del.ok) fails++;
  const gone=await fetch(BASE+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pseudo:target.profile.pseudo,password:'nouveauMdp123'})});
  console.log(!gone.ok?'✅ Le compte supprimé ne peut plus se connecter':'❌ le compte existe encore'); if(gone.ok) fails++;
  const meAfter=(await rA('/api/me')).d.profile;
  console.log(!meAfter.friends.includes(target.profile.slug)?'✅ Retiré de la liste d\'amis de l\'admin':'❌ encore dans les amis'); if(meAfter.friends.includes(target.profile.slug)) fails++;

  console.log(fails===0?'\n✅ Gestion admin des comptes validée.':'\n❌ '+fails+' échec(s)');
  process.exit(fails===0?0:1);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
