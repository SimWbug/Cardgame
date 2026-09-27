/* Vérifie la création de carte avec taux de drop personnalisé, armure,
   et les nouveaux effets de sort accessibles depuis le formulaire admin. */
const BASE='http://localhost:3000';
async function reg(p){const r=await fetch(BASE+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pseudo:p,password:'test1234'})});const d=await r.json();return{cookie:r.headers.getSetCookie().find(c=>c.startsWith('connect.sid')).split(';')[0],profile:d.profile};}

(async()=>{
  let fails=0;
  const A=await reg('DropAdmin_'+Date.now().toString(36));

  // 1) Carte avec armure
  const fd1=new FormData();
  fd1.append('code','admin123'); fd1.append('name','Golem Blindé'); fd1.append('type','minion');
  fd1.append('rarity','rare'); fd1.append('cost','4'); fd1.append('attack','3'); fd1.append('health','4');
  fd1.append('armor','3'); fd1.append('desc','Test armure');
  const r1=await fetch(BASE+'/api/admin/cards',{method:'POST',headers:{Cookie:A.cookie},body:fd1});
  const d1=await r1.json();
  console.log(r1.ok && d1.card.armor===3?'✅ Carte créée avec 3 armure':'❌ '+(d1.error||'armure incorrecte')); if(!r1.ok||d1.card.armor!==3) fails++;

  // 2) Carte avec taux de drop personnalisé (poids 10 = 10x plus fréquente que ses pairs)
  const fd2=new FormData();
  fd2.append('code','admin123'); fd2.append('name','Carte Fréquente'); fd2.append('type','minion');
  fd2.append('rarity','legendaire'); fd2.append('cost','1'); fd2.append('attack','1'); fd2.append('health','1');
  fd2.append('dropWeight','10');
  const r2=await fetch(BASE+'/api/admin/cards',{method:'POST',headers:{Cookie:A.cookie},body:fd2});
  const d2=await r2.json();
  console.log(r2.ok && d2.card.dropWeight===10?'✅ Poids de tirage personnalisé enregistré (10)':'❌ '+(d2.error||'poids incorrect')); if(!r2.ok||d2.card.dropWeight!==10) fails++;

  // 3) Poids hors bornes refusé
  const fd3=new FormData();
  fd3.append('code','admin123'); fd3.append('name','Trop Rare'); fd3.append('type','minion');
  fd3.append('rarity','commun'); fd3.append('cost','1'); fd3.append('attack','1'); fd3.append('health','1');
  fd3.append('dropWeight','999');
  const r3=await fetch(BASE+'/api/admin/cards',{method:'POST',headers:{Cookie:A.cookie},body:fd3});
  console.log(!r3.ok?'✅ Poids hors bornes (999) refusé':'❌ poids hors bornes accepté'); if(r3.ok) fails++;

  // 4) Carte sans poids précisé → poids par défaut (1)
  const fd4=new FormData();
  fd4.append('code','admin123'); fd4.append('name','Carte Normale'); fd4.append('type','minion');
  fd4.append('rarity','commun'); fd4.append('cost','2'); fd4.append('attack','2'); fd4.append('health','2');
  const r4=await fetch(BASE+'/api/admin/cards',{method:'POST',headers:{Cookie:A.cookie},body:fd4});
  const d4=await r4.json();
  console.log(r4.ok && d4.card.dropWeight===1?'✅ Poids par défaut (1) appliqué si non précisé':'❌ poids par défaut incorrect'); if(!r4.ok||d4.card.dropWeight!==1) fails++;

  // 5) Modifier le poids d'une carte existante
  const patch=await fetch(BASE+'/api/admin/cards/'+d4.card.id+'/drop-weight',{method:'PATCH',headers:{Cookie:A.cookie,'Content-Type':'application/json'},body:JSON.stringify({code:'admin123',dropWeight:5})});
  const pd=await patch.json();
  console.log(patch.ok && pd.card.dropWeight===5?'✅ Poids modifié après coup (5), estimation : '+pd.effectivePercent.toFixed(2)+'%':'❌ modification échouée'); if(!patch.ok) fails++;

  // 6) Sort "détruit tout le plateau"
  const fd5=new FormData();
  fd5.append('code','admin123'); fd5.append('name','Cataclysme'); fd5.append('type','sort');
  fd5.append('rarity','legendaire'); fd5.append('cost','8'); fd5.append('effectType','board_wipe'); fd5.append('value','0');
  const r5=await fetch(BASE+'/api/admin/cards',{method:'POST',headers:{Cookie:A.cookie},body:fd5});
  const d5=await r5.json();
  console.log(r5.ok && d5.card.effectType==='board_wipe'?'✅ Sort de destruction totale créé':'❌ '+(d5.error)); if(!r5.ok) fails++;

  // 7) Sort combiné (bonus ATQ + soin) avec value2
  const fd6=new FormData();
  fd6.append('code','admin123'); fd6.append('name','Bénédiction Double'); fd6.append('type','sort');
  fd6.append('rarity','epique'); fd6.append('cost','3'); fd6.append('effectType','buff_ally_and_heal');
  fd6.append('value','2'); fd6.append('value2','5');
  const r6=await fetch(BASE+'/api/admin/cards',{method:'POST',headers:{Cookie:A.cookie},body:fd6});
  const d6=await r6.json();
  console.log(r6.ok && d6.card.value2===5?'✅ Sort combiné créé avec value2=5':'❌ '+(d6.error)); if(!r6.ok||d6.card.value2!==5) fails++;

  console.log(fails===0?'\n✅ Taux de drop et armure validés depuis l\'admin.':'\n❌ '+fails+' échec(s)');
  process.exit(fails===0?0:1);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
