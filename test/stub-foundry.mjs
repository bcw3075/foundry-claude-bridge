/* A pretend Foundry server: a /join form like the real one and a /game page with just enough of the
   client API (game, canvas, ChatMessage, Roll, ui, foundry.applications) for the bridge's tools to run.
   Not Foundry; only plumbing. The server tracks who is logged in so the online check can be tested,
   and the page records real input (clicks, drags, keys) in window.__stub so the UI tools can be checked. */
import express from "express";

export function startStub(port = 30999) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.text({ type: "*/*" }));
  let world = { active: true };
  const online = new Set();
  const userNames = { u1: "Gamemaster", u2: "Claude Bridge", u3: "Test Player", u4: "AI" };
  app.get("/join", (req, res) => {
    if (!world.active) return res.send("<html><body><h1>Critical Failure!</h1><p>There is currently no active game session.</p></body></html>");
    res.send(`<html><body><form method="post" action="/join"><select name="userId"><option value="u1">Gamemaster</option><option value="u2">Claude Bridge</option><option value="u3">Test Player</option><option value="u4">AI</option></select><input name="password"><button name="join" type="submit">Join Game Session</button></form></body></html>`);
  });
  app.post("/join", (req, res) => { online.add(req.body.userId); res.setHeader("Set-Cookie", `session=${req.body.userId}; Path=/`); res.redirect("/game"); });
  app.post("/stub/logout", (req, res) => { online.delete(req.query.user); res.json({ ok: true }); });
  app.get("/stub/online", (req, res) => res.json([...online].map(id => userNames[id])));
  app.get("/game", (req, res) => {
    const uid = (req.headers.cookie ?? "").match(/session=(\w+)/)?.[1] ?? "u2";
    res.send(`<html><body style="margin:0">
      <div id="notifications"></div>
      <nav style="height:40px"><button id="open-dialog">Open Dialog</button><button id="count">Count</button><input id="name" name="name"><select id="pick" name="pick"><option value="a">a</option><option value="b">b</option></select></nav>
      <canvas id="board" width="800" height="500" style="display:block;background:#333"></canvas>
      <div id="apps"></div>
      <script>
      console.error("stub error line");
      const users=[{id:"u1",name:"Gamemaster",role:4,isGM:true,active:true},{id:"u2",name:"Claude Bridge",role:4,isGM:true,active:true},{id:"u3",name:"Test Player",role:1,isGM:false,active:false},{id:"u4",name:"AI",role:4,isGM:true,active:false}];
      const coll=arr=>({contents:arr,get:id=>arr.find(x=>x.id===id),getName:n=>arr.find(x=>x.name===n),find:f=>arr.find(f),filter:f=>arr.filter(f),map:f=>arr.map(f),get size(){return arr.length},[Symbol.iterator]:()=>arr[Symbol.iterator]()});
      const hp=(v,m)=>({value:v,max:m,temp:0});
      const mkActor=(id,name,type,level,v,m,items=[])=>({id,name,type,folder:null,system:{details:{level:{value:level},xp:{value:0}},attributes:{hp:hp(v,m),ac:{value:16},speed:{value:25}},saves:{fortitude:{value:5},reflex:{value:7},will:{value:4}},perception:{value:6},resources:{heroPoints:{value:1}},actions:[{label:"Dagger",totalModifier:7}]},items:coll(items.map((n,i)=>({id:"i"+i,name:n,type:n==="Frightened"?"condition":"weapon",value:n==="Frightened"?2:null}))),itemTypes:{condition:items.filter(n=>n==="Frightened").map(n=>({name:n,value:2}))}});
      const actors=[mkActor("a1","Test Hero","character",1,8,8,["Dagger","Frightened"]),mkActor("a2","Goblin Warrior","npc",-1,6,6)];
      const tokens=s=>coll([{id:"t1",name:"Test Hero",x:100,y:200,hidden:false,actorId:"a1",actor:actors[0],disposition:1,update:async function(d){Object.assign(this,d)}}]);
      const scenes=[{id:"s1",name:"Village sheet",active:true,navigation:true,width:4000,height:3000,grid:{size:150},tokens:tokens(),activate:async function(){scenes.forEach(s=>s.active=false);this.active=true},view:async function(){window.canvas.scene=this}},{id:"s2",name:"World Map",active:false,navigation:true,width:10672,height:7524,grid:{size:60},tokens:coll([]),activate:async function(){scenes.forEach(s=>s.active=false);this.active=true},view:async function(){window.canvas.scene=this}}];
      scenes.forEach(s=>{ s.levels={contents:[{id:"l"}]}; });
      const messages=[];let mid=0;
      window.ChatMessage={applyMode:(d,m)=>{d.mode=m;if(m==="gm")d.whisper=["u1","u2"]},create:async d=>{const m={id:"m"+(++mid),timestamp:Date.now(),author:{name:game.user.name},speaker:d.speaker,whisper:d.whisper??[],blind:!!d.blind,flavor:d.flavor??"",content:d.content,rolls:d.rolls??[]};messages.push(m);return m}};
      window.Roll=class{constructor(f){this.formula=f;this.total=0;this.dice=[]}async evaluate(){const m=this.formula.match(/(\\d+)d(\\d+)([+-]\\d+)?/);if(!m)throw new Error("bad formula");const n=+m[1],f=+m[2],b=+(m[3]||0);const r=[];for(let i=0;i<n;i++)r.push(1+Math.floor(Math.random()*f));this.dice=[{faces:f,results:r.map(x=>({result:x}))}];this.total=r.reduce((a,b)=>a+b,0)+b;return this}async toMessage(d,o){return ChatMessage.create({...d,content:"rolled "+this.total,rolls:[this],mode:o?.messageMode})}};
      const pages=[{id:"p1",name:"Overview",type:"text",text:{content:"<p>The village of <b>Millbrook</b>.</p><section class=\\"secret\\"><p>Goblins hide here.</p></section>"}}];
      /* Encounter Builder stand-in: the bridge reads its runner setting and whether a turn is busy */
      window.__stubFight=null; window.__stubSettings={};
      const encounterBuilder={id:"lythara-encounter-builder",version:"0.3.3",active:true,api:{fight:{current:c=>window.__stubFight}}};
      window.game={ready:true,version:"14.369",paused:false,world:{id:"pf2-test",title:"PF2 Test"},system:{id:"pf2e",version:"8.6.1"},
        user:Object.assign(users.find(u=>u.id==="${uid}"),{targets:new Set()}),users:Object.assign(coll(users),{activeGM:users[1]}),
        time:{worldTime:12345},modules:Object.assign([{id:"lythara-survey-sheet",version:"0.2.2",active:true,api:{createSheet:async a=>{await new Promise(r=>setTimeout(r,300));return {name:a.name||"Sheet",scene:"s9"}},renderSheet:async(s,o)=>({map:{bytes:1000,fingerprint:1}}),syncExploration:async()=>({harvested:1,restored:[["Village sheet",5]]}),exploredArea:()=>66.29,exportSheet:s=>({ok:true,scene:s.id,fingerprint:-356423167}),applySheet:async d=>({ok:true,sheets:[]})}},encounterBuilder],{get(id){return this.find(m=>m.id===id)}}),
        settings:{get:(ns,k)=>window.__stubSettings[k]},
        actors:coll(actors),scenes:Object.assign(coll(scenes),{get active(){return scenes.find(s=>s.active)}}),
        messages:coll(messages),combat:{started:true,round:2,turn:0,combatant:{name:"Test Hero"},turns:[{id:"c1",name:"Test Hero",initiative:18,defeated:false,hidden:false,actor:actors[0]},{id:"c2",name:"Goblin Warrior",initiative:12,defeated:false,hidden:false,actor:actors[1]}]},
        combats:coll([{id:"c1",started:true}]),
        journal:coll([{id:"j1",name:"Millbrook",folder:null,pages:coll(pages)}]),
        socket:{connected:true}};
      /* canvas: scene coordinates are twice the page pixels; real input is recorded in window.__stub */
      const board=document.getElementById("board");
      const toScene=ev=>{const r=board.getBoundingClientRect();return {x:Math.round((ev.clientX-r.left)*2),y:Math.round((ev.clientY-r.top)*2)}};
      window.canvas={ready:true,loading:false,scene:scenes[0],tokens:{controlled:[]},clientCoordinatesFromCanvas:({x,y})=>{const r=board.getBoundingClientRect();return {x:r.left+x/2,y:r.top+y/2}}};
      window.__stub={clicks:[],dbl:0,hovers:[],drags:[],keys:[],count:0,answered:null};
      let down=null;
      board.addEventListener("pointerdown",ev=>{window.__stub.clicks.push({...toScene(ev),button:ev.button,shift:ev.shiftKey,ctrl:ev.ctrlKey,trusted:ev.isTrusted});down={from:toScene(ev),moves:0}});
      board.addEventListener("pointermove",ev=>{if(down)down.moves++;window.__stub.hovers.push(toScene(ev))});
      board.addEventListener("pointerup",ev=>{if(down&&down.moves>2)window.__stub.drags.push({from:down.from,to:toScene(ev),moves:down.moves,trusted:ev.isTrusted});down=null});
      board.addEventListener("dblclick",()=>{window.__stub.dbl++});
      document.addEventListener("keydown",ev=>{window.__stub.keys.push(ev.key)});
      document.getElementById("count").addEventListener("click",ev=>{window.__stub.count++;window.__stub.lastCountClick={shift:ev.shiftKey,trusted:ev.isTrusted}});
      /* windows: foundry.applications.instances (v2) and ui.windows (v1), notifications in #notifications */
      window.foundry={applications:{instances:new Map(),api:{DialogV2:class DialogV2{}}}};
      window.ui={windows:{},controls:{control:{name:"tokens"},tool:{name:"select"}},notifications:{info:t=>note("info",t),warn:t=>note("warning",t),error:t=>note("error",t)}};
      const note=(type,text)=>{const li=document.createElement("li");li.className="notification "+type;li.textContent=text;document.getElementById("notifications").appendChild(li);setTimeout(()=>li.remove(),4000)};
      window.openDialog=()=>{const el=document.createElement("div");el.className="application dialog";el.style.cssText="position:absolute;left:300px;top:100px;width:300px;background:#eee;padding:8px";el.innerHTML='<h1 class="window-title">Confirm</h1><p>Are you sure?</p><input name="note" value="x"><button data-action="yes">Yes</button><button data-action="no">No</button>';document.getElementById("apps").appendChild(el);const d=new foundry.applications.api.DialogV2();d.id="dlg1";d.title="Confirm";d.element=el;foundry.applications.instances.set(d.id,d);el.querySelectorAll("button").forEach(b=>b.addEventListener("click",ev=>{window.__stub.answered=b.dataset.action;foundry.applications.instances.delete(d.id);el.remove()}));ui.notifications.info("Dialog opened");return d};
      document.getElementById("open-dialog").addEventListener("click",()=>openDialog());
      setInterval(async()=>{ try{ const a=await (await fetch("/stub/alive")).json(); if(!a.alive) location.href="/join"; users.forEach(u=>{u.active=a.online.includes(u.name)}); }catch(e){} },500);
      addEventListener("pagehide",()=>{navigator.sendBeacon("/stub/logout?user=${uid}")});
    </script></body></html>`);
  });
  app.get("/stub/alive", (req, res) => res.json({ alive: world.active, online: [...online].map(id => userNames[id]) }));
  app.post("/stub/restart", (req, res) => { world.active = false; online.clear(); setTimeout(() => { world.active = true; }, 5000); res.json({ ok: true }); });
  return new Promise(resolve => { const s = app.listen(port, "127.0.0.1", () => resolve({ port, close: () => s.close() })); });
}

if (process.argv[1]?.endsWith("stub-foundry.mjs")) startStub().then(s => console.log("stub foundry on", s.port));
