import test from 'node:test';import assert from 'node:assert/strict';import{EventEmitter}from'node:events';import http from'node:http';
import{listenBrowser,browserPortAllowed}from'../lib/browser-listen.mjs';
class FakeServer extends EventEmitter{
 constructor(ports,error){super();this.ports=ports;this.error=error;this.calls=0;this.closes=0;}
 listen(){this.bound=this.ports[this.calls++%this.ports.length];queueMicrotask(()=>this.emit(this.error?'error':'listening',this.error));}
 address(){return{port:this.bound};}
 close(done){this.closes++;queueMicrotask(()=>done());}
}
test('a browser-blocked ephemeral port is closed and another OS allocation is used',async()=>{const s=new FakeServer([10080,6000,49152]);assert.equal(await listenBrowser(s),s);assert.equal(s.calls,3);assert.equal(s.closes,2);assert.equal(s.listenerCount('error'),0)});
test('explicit blocked ports are rejected without binding or silently choosing a different port',async()=>{const s=new FakeServer([49152]);await assert.rejects(listenBrowser(s,{port:10080}),{code:'BROWSER_PORT_BLOCKED'});assert.equal(s.calls,0);assert.equal(browserPortAllowed(8780),true);assert.equal(browserPortAllowed(65536),false)});
test('repeated blocked allocations stop after a finite number of attempts',async()=>{const s=new FakeServer([6667]);await assert.rejects(listenBrowser(s),{code:'BROWSER_PORT_UNAVAILABLE'});assert.equal(s.calls,8);assert.equal(s.closes,8)});
test('an ordinary bind error is returned rather than retried on another port',async()=>{const s=new FakeServer([49152],Object.assign(Error('occupied'),{code:'EADDRINUSE'}));await assert.rejects(listenBrowser(s),{code:'EADDRINUSE'});assert.equal(s.calls,1);assert.equal(s.listenerCount('listening'),0)});
test('a real ephemeral HTTP listener can be accessed by the Fetch client',async t=>{const s=http.createServer((req,res)=>res.end('ready'));await listenBrowser(s);t.after(()=>new Promise(r=>s.close(r)));assert.equal(await(await fetch('http://127.0.0.1:'+s.address().port)).text(),'ready')});
