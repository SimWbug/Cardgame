/* Vérifie l'upload d'un son de carte et sa diffusion aux DEUX joueurs à la pose. */
const { io }=require('socket.io-client');
const fs=require('fs');
const BASE='http://localhost:3000';
function ensureWav(){
  if (fs.existsSync('/tmp/test-sound.wav')) return;
  const sr=8000,dur=0.1,n=Math.floor(sr*dur);
  const data=Buffer.alloc(n*2);
  for(let i=0;i<n;i++) data.writeInt16LE(Math.round(Math.sin(2*Math.PI*440*i/sr)*8000),i*2);
  const h=Buffer.alloc(44);
  h.write('RIFF',0);h.writeUInt32LE(36+data.length,4);h.write('WAVE',8);h.write('fmt ',12);
  h.writeUInt32LE(16,16);h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(sr,24);
  h.writeUInt32LE(sr*2,28);h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);
  fs.writeFileSync('/tmp/test-sound.wav',Buffer.concat([h,data]));
}
async function reg(p){const r=await fetch(BASE+'/api/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pseudo:p,password:'test1234'})});const d=await r.json();return{cookie:r.headers.getSetCookie().find(c=>c.startsWith('connect.sid')).split(';')[0],profile:d.profile};}
async function grantStarter(mk, user){
  const rU = mk(user.cookie);
  await rU('/api/admin/users/'+user.profile.slug+'/grant-starter','POST',{code:'admin123'});
  user.profile = (await rU('/api/me')).d.profile;
}
function mk(c){return async(p,m,b)=>{const r=await fetch(BASE+p,{method:m||'GET',headers:Object.assign({Cookie:c},b?{'Content-Type':'application/json'}:{}),body:b?JSON.stringify(b):undefined});return{ok:r.ok,d:await r.json().catch(()=>({}))};};}

(async()=>{
  ensureWav();
  let fails=0;
  const sfx=Date.now().toString(36);
  const A=await reg('SoundA_'+sfx), B=await reg('SoundB_'+sfx);
  const rA=mk(A.cookie), rB=mk(B.cookie);
  await grantStarter(mk, A);
  await grantStarter(mk, B);
  const wav=fs.readFileSync('/tmp/test-sound.wav');

  const fd=new FormData();
  fd.append('code','admin123'); fd.append('name','Cri du Testeur');
  fd.append('type','minion'); fd.append('rarity','commun'); fd.append('cost','0');
  fd.append('attack','1'); fd.append('health','1'); fd.append('desc','Carte sonore de test');
  fd.append('sound', new Blob([wav],{type:'audio/wav'}), 'test-sound.wav');
  const cr=await fetch(BASE+'/api/admin/cards',{method:'POST',headers:{Cookie:A.cookie},body:fd});
  const cd=await cr.json();
  console.log(cr.ok?'✅ Carte créée avec son : '+cd.card.sound:'❌ '+cd.error);
  if(!cr.ok){process.exit(1);}

  const sres=await fetch(BASE+cd.card.sound);
  console.log(sres.ok?'✅ Fichier audio accessible ('+sres.headers.get('content-type')+')':'❌ audio non servi');
  if(!sres.ok) fails++;

  const fdBad=new FormData();
  fdBad.append('code','admin123');
  fdBad.append('sound',new Blob([Buffer.from('pas du son')],{type:'text/plain'}),'x.txt');
  const bad=await fetch(BASE+'/api/admin/cards/'+cd.card.id+'/sound',{method:'POST',headers:{Cookie:A.cookie},body:fdBad});
  console.log(bad.ok?'❌ fichier texte accepté comme son':'✅ fichier non-audio refusé'); if(bad.ok) fails++;

  const seedCard='seed-02';
  const fd2=new FormData();
  fd2.append('code','admin123');
  fd2.append('sound', new Blob([wav],{type:'audio/wav'}), 'seed.wav');
  const up2=await fetch(BASE+'/api/admin/cards/'+seedCard+'/sound',{method:'POST',headers:{Cookie:A.cookie},body:fd2});
  const ud=await up2.json();
  console.log(up2.ok?'✅ Son ajouté à une carte du deck de départ ('+ud.card.name+')':'❌ '+ud.error);
  if(!up2.ok) fails++;

  await rA('/api/players/'+B.profile.slug+'/friend','POST');
  const sA=io(BASE,{extraHeaders:{Cookie:A.cookie}}), sB=io(BASE,{extraHeaders:{Cookie:B.cookie}});
  let stA=null,stB=null,ch=null; const soundsA=[],soundsB=[];
  sA.on('match:state',s=>stA=s); sB.on('match:state',s=>stB=s);
  sB.on('challenge:incoming',c=>ch=c);
  sA.on('card:sound',p=>soundsA.push(p)); sB.on('card:sound',p=>soundsB.push(p));

  await new Promise(r=>setTimeout(r,400));
  sA.emit('challenge:send',{toSlug:B.profile.slug});
  await new Promise(r=>setTimeout(r,400));
  sB.emit('challenge:accept',{challengeId:ch.id});
  await new Promise(r=>setTimeout(r,700));
  if(!stA){console.log('❌ combat non lancé');process.exit(1);}

  // Les deux joueurs valident leur main de départ sans rien remplacer
  sA.emit('action:mulligan',{cardIds:[]});
  sB.emit('action:mulligan',{cardIds:[]});
  await new Promise(r=>setTimeout(r,400));

  let played=false;
  for(let turn=0; turn<20 && !played; turn++){
    const cur=stA.yourTurn?{s:sA,v:()=>stA}:{s:sB,v:()=>stB};
    const st=cur.v();
    const target=st.you.hand.find(c=>c.id===seedCard && c.cost<=st.you.mana);
    if(target){ cur.s.emit('action:play',{cardId:seedCard}); await new Promise(r=>setTimeout(r,400)); played=true; break; }
    cur.s.emit('action:endTurn'); await new Promise(r=>setTimeout(r,250));
  }

  if(!played){ console.log('ℹ️ La carte sonore n\'est pas venue en main dans les tours testés (tirage aléatoire).'); }
  else {
    const gotA=soundsA.some(p=>p.cardId===seedCard);
    const gotB=soundsB.some(p=>p.cardId===seedCard);
    console.log(gotA?'✅ Le joueur qui pose entend le son':'❌ poseur n\'entend rien'); if(!gotA) fails++;
    console.log(gotB?'✅ L\'ADVERSAIRE entend aussi le son':'❌ adversaire n\'entend rien'); if(!gotB) fails++;
  }

  const del=await fetch(BASE+'/api/admin/cards/'+seedCard+'/sound',{method:'DELETE',headers:{Cookie:A.cookie,'Content-Type':'application/json'},body:JSON.stringify({code:'admin123'})});
  const dd=await del.json();
  console.log(del.ok && dd.card.sound===null?'✅ Son retiré de la carte':'❌ retrait du son échoué'); if(!del.ok) fails++;

  sA.disconnect(); sB.disconnect();
  console.log(fails===0?'\n✅ Sons de cartes validés.':'\n❌ '+fails+' échec(s)');
  process.exit(fails===0?0:1);
})().catch(e=>{console.error('❌',e.message);process.exit(1);});
