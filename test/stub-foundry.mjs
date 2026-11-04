/* A pretend Foundry server: a /join form like the real one and a /game page with just enough of the
   client API (game, canvas, ChatMessage, Roll) for the bridge's tools to run. Not Foundry; only plumbing. */
import express from "express";

export function startStub(port = 30999) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  let world = { active: true };
  app.get("/join", (req, res) => {
    if (!world.active) return res.send("<html><body><h1>Critical Failure!</h1><p>There is currently no active game session.</p></body></html>");
    res.send(`<html><body><form method="post" action="/join"><select name="userId"><option value="u1">Gamemaster</option><option value="u2">Claude Bridge</option><option value="u3">Test Player</option></select><input name="password"><button name="join" type="submit">Join Game Session</button></form></body></html>`);
  });
  app.post("/join", (req, res) => { res.setHeader("Set-Cookie", `session=${req.body.userId}; Path=/`); res.redirect("/game"); });
  app.get("/game", (req, res) => {
    const uid = (req.headers.cookie ?? "").match(/session=(\w+)/)?.[1] ?? "u2";
    res.send(`<html><body><canvas id="board"></canvas><script>
      const users=[{id:"u1",name:"Gamemaster",role:4,isGM:true,active:true},{id:"u2",name:"Claude Bridge",role:4,isGM:true,active:true},{id:"u3",name:"Test Player",role:1,isGM:false,active:false}];
      const coll=arr=>({contents:arr,get:id=>arr.find(x=>x.id===id),getName:n=>arr.find(x=>x.name===n),find:f=>arr.find(f),filter:f=>arr.filter(f),map:f=>arr.map(f),get size(){return arr.length},[Symbol.iterator]:()=>arr[Symbol.iterator]()});
      const hp=(v,m)=>({value:v,max:m,temp:0});
      const mkActor=(id,name,type,level,v,m,items=[])=>({id,name,type,folder:null,system:{details:{level:{value:level},xp:{value:0}},attributes:{hp:hp(v,m),ac:{value:16},speed:{value:25}},saves:{fortitude:{value:5},reflex:{value:7},will:{value:4}},perception:{value:6},resources:{heroPoints:{value:1}},actions:[{label:"Dagger",totalModifier:7}]},items:coll(items.map((n,i)=>({id:"i"+i,name:n,type:n==="Frightened"?"condition":"weapon",value:n==="Frightened"?2:null}))),itemTypes:{condition:items.filter(n=>n==="Frightened").map(n=>({name:n,value:2}))}});
      const actors=[mkActor("a1","Test Hero","character",1,8,8,["Dagger","Frightened"]),mkActor("a2","Goblin Warrior","npc",-1,6,6)];
      const tokens=s=>coll([{id:"t1",name:"Test Hero",x:100,y:200,hidden:false,actorId:"a1",actor:actors[0],disposition:1,update:async function(d){Object.assign(this,d)}}]);
      const scenes=[{id:"s1",name:"Stoneclaim sheet",active:true,navigation:true,width:4000,height:3000,grid:{size:150},tokens:tokens(),activate:async function(){scenes.forEach(s=>s.active=false);this.active=true},view:async function(){window.canvas.scene=this}},{id:"s2",name:"World Map",active:false,navigation:true,width:10672,height:7524,grid:{size:60},tokens:coll([]),activate:async function(){scenes.forEach(s=>s.active=false);this.active=true},view:async function(){window.canvas.scene=this}}];
      scenes.forEach(s=>{ s.levels={contents:[{id:"l"}]}; });
      const messages=[];let mid=0;
      window.ChatMessage={applyMode:(d,m)=>{d.mode=m;if(m==="gm")d.whisper=["u1","u2"]},create:async d=>{const m={id:"m"+(++mid),timestamp:Date.now(),author:{name:game.user.name},speaker:d.speaker,whisper:d.whisper??[],blind:!!d.blind,flavor:d.flavor??"",content:d.content,rolls:d.rolls??[]};messages.push(m);return m}};
      window.Roll=class{constructor(f){this.formula=f;this.total=0;this.dice=[]}async evaluate(){const m=this.formula.match(/(\\d+)d(\\d+)([+-]\\d+)?/);if(!m)throw new Error("bad formula");const n=+m[1],f=+m[2],b=+(m[3]||0);const r=[];for(let i=0;i<n;i++)r.push(1+Math.floor(Math.random()*f));this.dice=[{faces:f,results:r.map(x=>({result:x}))}];this.total=r.reduce((a,b)=>a+b,0)+b;return this}async toMessage(d,o){return ChatMessage.create({...d,content:"rolled "+this.total,rolls:[this],mode:o?.messageMode})}};
      const pages=[{id:"p1",name:"Overview",type:"text",text:{content:"<p>The village of <b>Stoneclaim</b>.</p><section class=\\"secret\\"><p>Goblins hide here.</p></section>"}}];
      window.game={ready:true,version:"14.369",paused:false,world:{id:"pf2-test",title:"PF2 Test"},system:{id:"pf2e",version:"8.6.1"},
        user:users.find(u=>u.id==="${uid}"),users:Object.assign(coll(users),{activeGM:users[1]}),
        time:{worldTime:12345},modules:Object.assign([{id:"lythara-survey-sheet",version:"0.2.2",active:true,api:{createSheet:async a=>{await new Promise(r=>setTimeout(r,300));return {name:a.name||"Sheet",scene:"s9"}},renderSheet:async(s,o)=>({map:{bytes:1000,fingerprint:1}}),syncExploration:async()=>({harvested:1,restored:[["Stoneclaim sheet",5]]}),exploredArea:()=>66.29,exportSheet:s=>({ok:true,scene:s.id,fingerprint:-356423167}),applySheet:async d=>({ok:true,sheets:[]})}}],{get(id){return this.find(m=>m.id===id)}}),
        actors:coll(actors),scenes:Object.assign(coll(scenes),{get active(){return scenes.find(s=>s.active)}}),
        messages:coll(messages),combat:{started:true,round:2,turn:0,combatant:{name:"Test Hero"},turns:[{id:"c1",name:"Test Hero",initiative:18,defeated:false,hidden:false,actor:actors[0]},{id:"c2",name:"Goblin Warrior",initiative:12,defeated:false,hidden:false,actor:actors[1]}]},
        journal:coll([{id:"j1",name:"Stoneclaim",folder:null,pages:coll(pages)}]),
        socket:{connected:true}};
      window.canvas={ready:true,scene:scenes[0]};
      setInterval(async()=>{ try{ const a=await (await fetch("/stub/alive")).json(); if(!a.alive) location.href="/join"; }catch(e){} },1000);
    </script></body></html>`);
  });
  app.get("/stub/alive", (req, res) => res.json({ alive: world.active }));
  app.post("/stub/restart", (req, res) => { world.active = false; setTimeout(() => { world.active = true; }, 5000); res.json({ ok: true }); });
  return new Promise(resolve => { const s = app.listen(port, "127.0.0.1", () => resolve({ port, close: () => s.close() })); });
}

if (process.argv[1]?.endsWith("stub-foundry.mjs")) startStub().then(s => console.log("stub foundry on", s.port));
