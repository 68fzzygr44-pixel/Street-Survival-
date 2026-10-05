
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const rooms = new Map();

function code() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  do {
    s = Array.from({length: 5}, () => chars[Math.floor(Math.random()*chars.length)]).join("");
  } while (rooms.has(s));
  return s;
}

function send(ws, type, data={}) {
  if (ws.readyState === 1) ws.send(JSON.stringify({type, ...data}));
}
function broadcast(room, type, data={}) {
  room.players.forEach(p => send(p.ws, type, data));
}
function publicState(room) {
  return {
    round: room.round,
    phase: room.phase,
    target: 5000,
    players: room.players.map(p => ({
      id:p.id, name:p.name, money:p.money, health:p.health, heat:p.heat, reputation:p.reputation
    })),
    log: room.log.slice(-8)
  };
}
function pushState(room) { broadcast(room, "state", {state: publicState(room)}); }

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 30) room.log.shift();
}

function resetRoom(room) {
  room.round = 1;
  room.phase = "playing";
  room.log = ["Reach $5,000 before your opponent."];
  room.players.forEach((p,i)=>Object.assign(p,{
    money:500, health:100, heat:0, reputation:0, acted:false,
    name:p.name || `Player ${i+1}`
  }));
}

function resolve(room) {
  const acted = room.players.filter(p=>p.acted);
  if (acted.length < room.players.length) return;

  const results = [];
  for (const p of room.players) {
    let msg = `${p.name} `;
    if (p.action === "work") { p.money += 250; p.heat = Math.max(0,p.heat-1); msg += "worked a shift and earned $250."; }
    if (p.action === "rob") {
      const success = Math.random() < 0.65;
      if (success) { p.money += 650; p.heat += 2; p.reputation += 1; msg += "pulled off a robbery for $650."; }
      else { p.health -= 15; p.heat += 3; msg += "got caught during a robbery and lost 15 health."; }
    }
    if (p.action === "invest") {
      const gain = Math.random() < 0.55 ? 400 : -150;
      p.money = Math.max(0,p.money+gain);
      msg += gain >= 0 ? `invested and gained $${gain}.` : `made a bad investment and lost $${-gain}.`;
    }
    if (p.action === "laylow") { p.heat = Math.max(0,p.heat-3); p.health = Math.min(100,p.health+10); msg += "laid low and recovered."; }
    if (p.action === "challenge") {
      const target = room.players.find(x=>x.id !== p.id);
      if (target) {
        const win = Math.random() < 0.5;
        if (win) { const stolen=Math.min(250,target.money); target.money-=stolen; p.money+=stolen; p.reputation+=1; msg += `won a challenge and took $${stolen}.`; }
        else { p.health-=10; msg += "lost a challenge and took 10 damage."; }
      }
    }
    results.push(msg);
  }

  results.forEach(x=>addLog(room,x));
  room.players.forEach(p=>p.acted=false);
  const winner = room.players.find(p=>p.money>=5000 || p.health<=0);
  if (winner) {
    room.phase="finished";
    addLog(room, `${winner.name} wins the game!`);
  } else {
    room.round++;
  }
  pushState(room);
}

wss.on("connection", ws => {
  ws.on("message", raw => {
    let m;
    try { m=JSON.parse(raw); } catch { return; }

    if (m.type==="create") {
      const room={players:[],round:1,phase:"playing",log:["Reach $5,000 before your opponent."]};
      const id=Math.random().toString(36).slice(2,8);
      const p={id,ws,name:String(m.name||"Player 1").slice(0,16),money:500,health:100,heat:0,reputation:0,acted:false};
      room.players.push(p); rooms.set(code(),room);
      const roomCode=[...rooms.entries()].find(([,r])=>r===room)[0];
      ws.room=roomCode; ws.playerId=id;
      send(ws,"joined",{room:roomCode,id,host:true});
      pushState(room);
    }

    if (m.type==="join") {
      const room=rooms.get(String(m.room||"").toUpperCase());
      if (!room) return send(ws,"error",{message:"Room not found."});
      if (room.players.length>=2) return send(ws,"error",{message:"That room is full."});
      if (room.phase==="finished") return send(ws,"error",{message:"That game is finished."});
      const id=Math.random().toString(36).slice(2,8);
      const p={id,ws,name:String(m.name||"Player 2").slice(0,16),money:500,health:100,heat:0,reputation:0,acted:false};
      room.players.push(p); ws.room=String(m.room).toUpperCase(); ws.playerId=id;
      send(ws,"joined",{room:ws.room,id,host:false});
      addLog(room, `${p.name} joined the room.`);
      pushState(room);
    }

    if (m.type==="action") {
      const room=rooms.get(ws.room); if(!room || room.phase!=="playing") return;
      const p=room.players.find(x=>x.id===ws.playerId); if(!p || p.acted) return;
      const allowed=["work","rob","invest","laylow","challenge"];
      if(!allowed.includes(m.action)) return;
      if (room.players.length<2) return send(ws,"error",{message:"Waiting for another player to join."});
      p.action=m.action; p.acted=true;
      send(ws,"waiting",{message:"Locked in. Waiting for the other player..."});
      resolve(room);
    }

    if (m.type==="restart") {
      const room=rooms.get(ws.room); if(!room) return;
      resetRoom(room); pushState(room);
    }
  });
  ws.on("close",()=>{
    const room=rooms.get(ws.room); if(!room) return;
    room.players=room.players.filter(p=>p.ws!==ws);
    if(room.players.length===0) rooms.delete(ws.room);
    else { addLog(room,"The other player disconnected."); pushState(room); }
  });
});

const PORT=process.env.PORT||3000;
server.listen(PORT,()=>console.log(`Street Survival running on ${PORT}`));
