const express=require('express');
const http=require('http');
const path=require('path');
const QRCode=require('qrcode');
const {WebSocketServer}=require('ws');

const app=express();
const server=http.createServer(app);
const wss=new WebSocketServer({server});

app.use(express.static(__dirname));

app.get('/',(_,res)=>res.sendFile(path.join(__dirname,'host.html')));
app.get('/join/:room',(_,res)=>res.sendFile(path.join(__dirname,'join.html')));

app.get('/qr',async(req,res)=>{
  const text=String(req.query.text||'');
  if(!text)return res.status(400).send('missing');
  try{
    res.type('png').send(await QRCode.toBuffer(text,{type:'png',width:720,margin:2}));
  }catch{
    res.status(500).send('qr error');
  }
});

const rooms=new Map();
const MAX=12;
const FINISH=300; // v6: трасса в 3 раза длиннее

function room(code){
  if(!rooms.has(code)){
    rooms.set(code,{
      code,
      host:null,
      players:new Map(),
      running:false,
      winner:null,
      finish:FINISH
    });
  }
  return rooms.get(code);
}

function state(r){
  return{
    type:'state',
    room:r.code,
    running:r.running,
    winner:r.winner,
    finish:r.finish,
    maxPlayers:MAX,
    players:[...r.players.values()].map(p=>({
      id:p.id,
      clientId:p.clientId,
      name:p.name,
      team:p.team,
      level:p.level,
      position:p.position,
      connected:p.connected
    }))
  };
}

function send(ws,o){
  if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));
}
function broadcast(r){
  const s=state(r);
  send(r.host,s);
  for(const p of r.players.values())send(p.ws,s);
}

wss.on('connection',ws=>{
  ws.meta={role:null,room:null,clientId:null};

  ws.on('message',raw=>{
    let m;
    try{m=JSON.parse(String(raw))}catch{return}

    if(m.type==='host_join'){
      const c=String(m.room||'').toUpperCase().slice(0,8);
      if(!c)return;
      const r=room(c);
      r.host=ws;
      ws.meta={role:'host',room:c,clientId:null};
      broadcast(r);
      return;
    }

    if(m.type==='player_join'){
      const c=String(m.room||'').toUpperCase().slice(0,8);
      const cid=String(m.clientId||'').slice(0,64);
      const team=m.team==='girl'?'girl':'boy';
      if(!c||!cid)return;

      const r=room(c);
      let p=r.players.get(cid);

      if(p){
        p.ws=ws;
        p.connected=true;
        p.name=String(m.name||p.name||'Игрок').slice(0,24);
        p.team=team;
        p.lastSeen=Date.now();
      }else{
        if(r.players.size>=MAX){
          send(ws,{type:'room_full',maxPlayers:MAX});
          return;
        }
        p={
          id:Math.random().toString(36).slice(2,10),
          clientId:cid,
          name:String(m.name||'Игрок').slice(0,24),
          team,
          ws,
          level:0,
          position:0,
          connected:true,
          lastSeen:Date.now()
        };
        r.players.set(cid,p);
      }

      ws.meta={role:'player',room:c,clientId:cid};
      send(ws,{type:'joined',id:p.id,room:c});
      broadcast(r);
      return;
    }

    const r=ws.meta.room?rooms.get(ws.meta.room):null;
    if(!r)return;

    if(m.type==='start'&&ws.meta.role==='host'){
      r.running=true;
      r.winner=null;
      for(const p of r.players.values()){
        p.position=0;
        p.level=0;
      }
      broadcast(r);
      return;
    }

    if(m.type==='reset'&&ws.meta.role==='host'){
      r.running=false;
      r.winner=null;
      for(const p of r.players.values()){
        p.position=0;
        p.level=0;
      }
      broadcast(r);
      return;
    }

    if(m.type==='clear_players'&&ws.meta.role==='host'){
      r.running=false;
      r.winner=null;
      for(const p of r.players.values()){
        send(p.ws,{type:'cleared'});
        try{p.ws?.close()}catch{}
      }
      r.players.clear();
      broadcast(r);
      return;
    }

    if(m.type==='level'&&ws.meta.role==='player'){
      const p=r.players.get(ws.meta.clientId);
      if(!p)return;
      p.level=Math.max(0,Math.min(1,Number(m.level||0)));
      p.lastSeen=Date.now();
    }
  });

  ws.on('close',()=>{
    const {role,room:c,clientId}=ws.meta||{};
    const r=c?rooms.get(c):null;
    if(!r)return;

    if(role==='host'&&r.host===ws)r.host=null;

    if(role==='player'){
      const p=r.players.get(clientId);
      if(p&&p.ws===ws){
        p.connected=false;
        p.level=0;
        p.ws=null;
      }
    }
    broadcast(r);
  });
});

setInterval(()=>{
  for(const r of rooms.values()){
    if(!r.running||r.winner)continue;

    const teams={
      boy:{level:0,n:0},
      girl:{level:0,n:0}
    };

    for(const p of r.players.values()){
      if(p.connected){
        teams[p.team].level+=p.level;
        teams[p.team].n++;
      }
    }

    for(const t of ['boy','girl']){
      const members=[...r.players.values()].filter(p=>p.team===t);
      const avg=teams[t].n?teams[t].level/teams[t].n:0;
      const active=avg>.07?avg:0;
      const speed=Math.pow(active,1.28)*0.92;

      for(const p of members){
        p.position=Math.min(r.finish,p.position+speed);
        if(Date.now()-p.lastSeen>300)p.level*=.72;
      }
    }

    const bp=[...r.players.values()].find(p=>p.team==='boy');
    const gp=[...r.players.values()].find(p=>p.team==='girl');
    const bpos=bp?bp.position:0;
    const gpos=gp?gp.position:0;

    if(bpos>=r.finish||gpos>=r.finish){
      r.running=false;
      r.winner={
        team:bpos>=r.finish?'boy':'girl',
        name:bpos>=r.finish?'КОМАНДА МАЛЬЧИКА':'КОМАНДА ДЕВОЧКИ'
      };
    }

    broadcast(r);
  }
},50);

const port=process.env.PORT||3000;
server.listen(port,'0.0.0.0',()=>{
  console.log('Накричи ЗА ребёнка v6 запущено:',port);
});
