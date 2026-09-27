/* Test de la clôture de saison : on simule un mois précédent puis on vérifie
   la distribution 500/250/100 et la remise à zéro. */
const assert=require('assert');
const db=require('./src/db');
const ranking=require('./src/ranking');
const { buildStarterCollection, rankFor }=require('./src/cards');

function mkUser(slug,pseudo,vp,wins){
  const {collection,deck}=buildStarterCollection();
  return db.createUser({slug,pseudo,passHash:'x',credits:100,dust:0,lastPack:0,collection,deck,
    friends:[],avatar:null,ornament:'none',ownedOrnaments:['none'],
    seasonVP:vp,seasonWins:wins,seasonLosses:0,lifetimeWins:0,lifetimeLosses:0,createdAt:Date.now()});
}

mkUser('alpha','Alpha',900,30);
mkUser('beta','Beta',500,20);
mkUser('gamma','Gamma',250,10);
mkUser('delta','Delta',50,2);

// Classement avant clôture
const board=ranking.buildLeaderboard(db.allUsers());
assert.strictEqual(board[0].slug,'alpha','Alpha doit être premier');
assert.strictEqual(board[1].slug,'beta');
assert.strictEqual(board[2].slug,'gamma');
console.log('✅ Classement trié correctement :',board.map(b=>b.pseudo+'('+b.vp+')').join(' > '));

// Vérification des rangs
assert.strictEqual(rankFor(900).key,'or','900 pts = Or');
assert.strictEqual(rankFor(50).key,'bronze','50 pts = Bronze');
console.log('✅ Rangs attribués selon les points (Or pour 900, Bronze pour 50).');

// On force une saison précédente pour déclencher la clôture
const meta=db.getMeta();
meta.currentSeason='2020-01';
db.saveMeta(meta);

const result=ranking.closeSeasonIfNeeded(db);
assert.ok(result,'La clôture doit avoir eu lieu');
const podium=result.closedSeason.podium;
console.log('✅ Saison clôturée. Podium :');
podium.forEach(p=>console.log('   '+p.position+'. '+p.pseudo+' — '+p.vp+' pts → +'+p.reward+' ✧'));

assert.strictEqual(podium[0].reward,500,'Le 1er doit recevoir 500 poussière');
assert.strictEqual(podium[1].reward,250,'Le 2e doit recevoir 250 poussière');
assert.strictEqual(podium[2].reward,100,'Le 3e doit recevoir 100 poussière');
console.log('✅ Récompenses 500 / 250 / 100 correctes.');

// La poussière a bien été créditée
assert.strictEqual(db.getUser('alpha').dust,500);
assert.strictEqual(db.getUser('beta').dust,250);
assert.strictEqual(db.getUser('gamma').dust,100);
assert.strictEqual(db.getUser('delta').dust,0,'Le 4e ne reçoit rien');
console.log('✅ Poussière créditée aux 3 premiers uniquement.');

// Remise à zéro des compteurs de saison
['alpha','beta','gamma','delta'].forEach(s=>{
  const u=db.getUser(s);
  assert.strictEqual(u.seasonVP,0,'Les points doivent être remis à zéro');
  assert.strictEqual(u.seasonWins,0,'Les victoires de saison doivent être remises à zéro');
});
assert.strictEqual(db.getUser('alpha').lifetimeWins,30,'Les victoires doivent être archivées en total à vie');
console.log('✅ Compteurs de saison remis à zéro, historique conservé (Alpha : 30 victoires à vie).');

// Une deuxième clôture dans le même mois ne doit rien faire
const again=ranking.closeSeasonIfNeeded(db);
assert.strictEqual(again,null,'Pas de double clôture dans le même mois');
assert.strictEqual(db.getUser('alpha').dust,500,'La poussière ne doit pas être versée deux fois');
console.log('✅ Pas de double distribution des récompenses.');

console.log('\n✅ Classement mensuel entièrement validé.');
