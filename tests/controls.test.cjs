const {test} = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../static/dashboard.js'), 'utf8');

function setup() {
    const nodes = new Map(), documentEvents = {}, windowEvents = {}, intervals = new Map(), published = [];
    let nextTimer = 0;
    function node() {
        return {textContent: '', checked: false, disabled: false, value: '', dataset: {}, events: {}, childNodes: [],
            classList: {add(){}, remove(){}, replace(){}, toggle(){}},
            addEventListener(name, fn){this.events[name]=fn;},
            appendChild(child){this.childNodes.push(child);}, removeChild(){this.childNodes.shift();},
            removeAttribute(){}, setPointerCapture(){}};
    }
    const buttons = [node(), node(), node(), node()];
    ['0.5,0','0,0.5','0,-0.5','-0.5,0'].forEach((motion,i)=>buttons[i].dataset.motion=motion);
    const document = {hidden: false, getElementById(id){if (!nodes.has(id)) nodes.set(id,node());return nodes.get(id);},
        createElement: node, querySelectorAll(q){return q==='[data-motion]'?buttons:[];},
        addEventListener(name, fn){documentEvents[name]=fn;}};
    const window = {location:{protocol:'http:'}, confirm(){return true;}, addEventListener(name,fn){windowEvents[name]=fn;}};
    const sockets = [], topics = [];
    function Ros(){this.isConnected=false;this.events={};sockets.push(this);}
    Ros.prototype.on=function(name,fn){this.events[name]=fn;};
    Ros.prototype.connect=function(url){this.url=url;};
    Ros.prototype.close=function(){this.isConnected=false;this.events.close?.();};
    function Topic(options){Object.assign(this,options);topics.push(this);}
    Topic.prototype.publish=function(msg){published.push({topic:this.name,msg});};
    Topic.prototype.subscribe=function(fn){this.callback=fn;};
    Topic.prototype.unsubscribe=function(){this.unsubscribed=true;};
    Topic.prototype.unadvertise=function(){this.unadvertised=true;};
    const ctx=vm.createContext({document,window,ROSLIB:{Ros,Topic,Message:function(data){Object.assign(this,data);}},
        setInterval(fn){const id=++nextTimer;intervals.set(id,fn);return id;},clearInterval(id){intervals.delete(id);},console});
    vm.runInContext(source,ctx);
    const run=code=>vm.runInContext(code,ctx);
    function connect(){document.getElementById('jetson-ip').value='robot.local';run('connectROS()');const socket=sockets.at(-1);socket.isConnected=true;socket.events.connection();return socket;}
    function enable(){run('toggleEStop()');nodes.get('manual-override-toggle').checked=true;run('toggleManualOverride()');published.length=0;}
    const keydown=(key='w',target={tagName:'BODY'})=>documentEvents.keydown({key,target,preventDefault(){}});
    const tick=()=>{for(const fn of [...intervals.values()])fn();};
    const moving=()=>published.some(x=>x.topic==='/cmd_vel' && (x.msg.linear.x!==0 || x.msg.angular.z!==0));
    return {nodes,document,documentEvents,windowEvents,buttons,intervals,published,sockets,topics,run,connect,enable,keydown,tick,moving};
}

test('D-pad and keyboard require connection, released stop and manual mode',()=>{
    const s=setup();s.buttons[0].events.pointerdown({pointerType:'mouse',button:0,preventDefault(){}});assert.equal(s.moving(),false);
    s.connect();s.keydown();assert.equal(s.moving(),false);s.run('toggleEStop()');s.keydown();assert.equal(s.moving(),false);
});
test('manual OFF clears timer and held keys',()=>{
    const s=setup();s.connect();s.enable();s.keydown();assert.equal(s.moving(),true);
    s.nodes.get('manual-override-toggle').checked=false;s.run('toggleManualOverride()');s.published.length=0;s.tick();
    assert.equal(s.moving(),false);assert.equal(s.intervals.size,0);
    s.nodes.get('manual-override-toggle').checked=true;s.run('toggleManualOverride()');s.published.length=0;s.tick();assert.equal(s.moving(),false);
});
test('STOP remains stopped while key remains held',()=>{
    const s=setup();s.connect();s.enable();s.keydown();s.run('stopRobot()');s.published.length=0;s.tick();assert.equal(s.moving(),false);assert.equal(s.intervals.size,0);
});
test('keyup sends final zero and clears timer',()=>{
    const s=setup();s.connect();s.enable();s.keydown();s.documentEvents.keyup({key:'w'});
    assert.equal(s.published.at(-1).msg.linear.x,0);assert.equal(s.intervals.size,0);
});
for(const event of ['blur','pagehide','beforeunload'])test(`${event} clears movement`,()=>{
    const s=setup();s.connect();s.enable();s.keydown();s.windowEvents[event]();s.published.length=0;s.tick();assert.equal(s.moving(),false);assert.equal(s.intervals.size,0);
});
test('hidden page stops manual movement',()=>{
    const s=setup();s.connect();s.enable();s.keydown();s.document.hidden=true;s.documentEvents.visibilitychange();s.published.length=0;s.tick();assert.equal(s.moving(),false);
});
test('disconnect never queues movement and reconnect requires explicit release',()=>{
    const s=setup();const old=s.connect();s.enable();s.keydown();old.isConnected=false;s.published.length=0;old.events.close();s.tick();assert.equal(s.published.length,0);
    s.connect();s.published.length=0;s.keydown();s.tick();assert.equal(s.moving(),false);assert.equal(s.nodes.get('manual-override-toggle').checked,false);
});
test('stale close callback cannot disable replacement socket',()=>{
    const s=setup();const old=s.connect();s.connect();old.events.close();assert.equal(s.nodes.get('status-text').textContent,'CONNECTED');
});
test('E-stop sends zero and RESET; START and resume are blocked',()=>{
    const s=setup();s.connect();s.enable();s.keydown();s.run('toggleEStop()');
    assert.ok(s.published.some(x=>x.topic==='/cmd_vel' && x.msg.linear.x===0));assert.ok(s.published.some(x=>x.msg.data==='RESET'));
    s.published.length=0;s.run('startMission(); toggleHoldResume()');s.tick();assert.equal(s.published.length,0);
});
test('pointer repeat stops on cancel and lost capture',()=>{
    for(const event of ['pointerup','pointercancel','lostpointercapture','pointerleave']){
        const s=setup();s.connect();s.enable();s.buttons[0].events.pointerdown({pointerType:'touch',pointerId:1,preventDefault(){}});
        assert.equal(s.moving(),true);s.buttons[0].events[event]();s.published.length=0;s.tick();assert.equal(s.moving(),false);
    }
});
test('typing into an input never issues a command',()=>{
    const s=setup();s.connect();s.enable();s.keydown('w',{tagName:'INPUT'});s.documentEvents.keyup({key:'w'});assert.equal(s.published.length,0);
});
test('untrusted logs remain plain text',()=>{
    const s=setup();s.run('logTerminal("<img src=x onerror=alert(1)>")');const log=s.nodes.get('ros-logs').childNodes.at(-1);
    assert.ok(log.textContent.includes('<img'));assert.equal(log.innerHTML,undefined);
});
test('old subscriptions are removed and stale messages ignored',()=>{
    const s=setup();s.connect();const state=s.topics.find(t=>t.name==='/current_state');s.connect();assert.equal(state.unsubscribed,true);
    state.callback({data:'OLD STATE'});assert.notEqual(s.nodes.get('val-state').textContent,'OLD STATE');
});

test('permission-state pause interlock survives UI refreshes',()=>{
    const s=setup();s.connect();s.enable();
    const state=s.topics.find(topic=>topic.name==='/current_state');state.callback({data:'6 PERMISSION'});
    s.nodes.get('manual-override-toggle').checked=false;s.run('toggleManualOverride()');
    assert.equal(s.nodes.get('hold-resume-btn').disabled,true);
    s.published.length=0;s.run('toggleHoldResume()');assert.equal(s.published.length,0);
});
test('pause label follows robot state rather than stale local state',()=>{
    const s=setup();s.connect();const state=s.topics.find(topic=>topic.name==='/current_state');
    state.callback({data:'7 PAUSED'});assert.equal(s.nodes.get('hold-resume-text').textContent,'CONTINUE');
    state.callback({data:'0 SEARCHING'});assert.equal(s.nodes.get('hold-resume-text').textContent,'PAUSE');
});
