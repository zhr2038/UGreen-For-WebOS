import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {requestNas} from '../lib/native-http.mjs';
const options={server:'https://owned.example.ug.link',path:'/ugreen/v1/verify/handshake',readAuth:{clientId:'fake-client',token:'fake-token'},timeout:3000};
test('bounded relay timer preserves its own NAS_TIMEOUT through request error handling',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});let destroyed;
 const work=requestNas(options,{request(url,settings){assert.equal(settings.rejectUnauthorized,true);const request=new EventEmitter();request.setTimeout=ms=>assert.equal(ms,3000);request.end=()=>{};request.destroy=cause=>{destroyed=cause;queueMicrotask(()=>request.emit('error',cause));};return request;}});
 const rejected=assert.rejects(work,{code:'NAS_TIMEOUT'});t.mock.timers.tick(2999);assert.equal(destroyed,undefined);t.mock.timers.tick(1);await rejected;assert.equal(destroyed.code,'NAS_TIMEOUT');assert.equal(destroyed.message.includes('owned'),false);
});
test('known network TLS codes survive while arbitrary provider messages and codes are sanitized',async()=>{
 for(const [code,expected]of [['ERR_TLS_CERT_ALTNAME_INVALID','ERR_TLS_CERT_ALTNAME_INVALID'],['ECONNRESET','ECONNRESET'],['PRIVATE_TOKEN_SUFFIX','NAS_REQUEST_FAILED'],[123,'NAS_REQUEST_FAILED']]){
  await assert.rejects(requestNas(options,{request(){throw Object.assign(new Error('secret-host /private fake-token'),{code});}}),cause=>cause.code===expected&&!cause.message.includes('secret-host')&&!cause.message.includes('fake-token'));
 }
});
test('HTTP status diagnostics retain only the bounded status number',async()=>{
 let destroyed=false;await assert.rejects(requestNas(options,{request(url,settings,done){const request=new EventEmitter();request.setTimeout=()=>{};request.destroy=cause=>queueMicrotask(()=>request.emit('error',cause));request.end=()=>queueMicrotask(()=>done({statusCode:503,socket:{},destroy(){destroyed=true;}}));queueMicrotask(()=>request.emit('socket',{}));return request;}}),cause=>cause.code==='NAS_HTTP_STATUS'&&cause.httpStatus===503&&!cause.message.includes('owned'));assert.equal(destroyed,true);
});
