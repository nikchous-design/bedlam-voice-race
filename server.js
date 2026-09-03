const express = require('express');
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'host.html')));
app.get('/join/:room', (req, res) => res.sendFile(path.join(__dirname, 'join.html')));
app.get('/qr', async (req, res) => {
  const text = String(req.query.text || '');
  if (!text) return res.status(400).send('missing text');
  try {
    const png = await QRCode.toBuffer(text,{type:'png',width:520,margin:2,color:{dark:'#111111',light:'#ffffff'}});
    res.type('png').send(png);
  } catch { res.status(500).send('qr error'); }
});

const rooms = new Map();
function makeRoom(code){ if(!rooms.has(code)) rooms.set(code,{code,host:null,players:new Map(),running:false,winner:null,finish:100}); return rooms.get(code); }
function stateOf(room){ return {type:'state',room:room.code,running:room.running,winner:room.winner,finish:room.finish,players:[...room.players.values()].map(p=>({id:p.id,name:p.name,level:p.level,position:p.position,connected:p.connected}))}; }
function send(ws,obj){ if(ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }
function broadcast(room){ const s=stateOf(room); send(room.host,s); for(const p of room.players.values()) send(p.ws,s); }

wss.on('connection', ws => {
  ws.meta={role:null,room:null,playerId:null};
  ws.on('message', raw => {
    let msg; try{ msg=JSON.parse(String(raw)); }catch{return;}
    if(msg.type==='host_join'){
      const code=String(msg.room||'').toUpperCase().slice(0,8); if(!code)return;
      const room=makeRoom(code); room.host=ws; ws.meta={role:'host',room:code,playerId:null}; broadcast(room); return;
    }
    if(msg.type==='player_join'){
      const code=String(msg.room||'').toUpperCase().slice(0,8); if(!code)return;
      const room=makeRoom(code); const id=Math.random().toString(36).slice(2,10);
      room.players.set(id,{id,name:String(msg.name||'Игрок').slice(0,24),ws,level:0,position:0,connected:true,lastSeen:Date.now()});
      ws.meta={role:'player',room:code,playerId:id}; send(ws,{type:'joined',id,room:code}); broadcast(room); return;
    }
    const room=ws.meta.room?rooms.get(ws.meta.room):null; if(!room)return;
    if(msg.type==='start' && ws.meta.role==='host'){
      room.running=true; room.winner=null; for(const p of room.players.values()){p.position=0;p.level=0;} broadcast(room); return;
    }
    if(msg.type==='reset' && ws.meta.role==='host'){
      room.running=false; room.winner=null; for(const p of room.players.values()){p.position=0;p.level=0;} broadcast(room); return;
    }
    if(msg.type==='level' && ws.meta.role==='player'){
      const p=room.players.get(ws.meta.playerId); if(!p)return; p.level=Math.max(0,Math.min(1,Number(msg.level||0))); p.lastSeen=Date.now();
    }
  });
  ws.on('close',()=>{
    const {role,room:code,playerId}=ws.meta||{}; const room=code?rooms.get(code):null; if(!room)return;
    if(role==='host' && room.host===ws) room.host=null;
    if(role==='player'){ const p=room.players.get(playerId); if(p){p.connected=false;p.level=0;p.ws=null;} }
    broadcast(room);
  });
});

setInterval(()=>{
  for(const room of rooms.values()){
    if(!room.running || room.winner) continue;
    let winner=null;
    for(const p of room.players.values()){
      if(!p.connected) continue;
      const active=p.level>0.08?p.level:0; const speed=Math.pow(active,1.35)*0.95; p.position=Math.min(room.finish,p.position+speed);
      if(Date.now()-p.lastSeen>250) p.level*=0.7;
      if(p.position>=room.finish && !winner) winner=p;
    }
    if(winner){ room.running=false; room.winner={id:winner.id,name:winner.name}; }
    broadcast(room);
  }
},50);

const port=process.env.PORT||3000;
server.listen(port,'0.0.0.0',()=>console.log(`Voice Race запущен на порту ${port}`));
