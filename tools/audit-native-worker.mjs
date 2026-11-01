import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,join} from 'node:path';
const root=resolve(import.meta.dirname,'..'),hash=b=>createHash('sha256').update(b).digest('hex');
export async function auditNativeWorker({record=false}={}){
 const worker=await readFile(join(root,'assets/native-worker-armv7/p2p-connect-worker')),source=await readFile(join(root,'native/worker.c')),header=await readFile(join(root,'native/worker-got.h'));
 if(worker.readUInt32LE(0)!==0x464c457f||worker[4]!==1||worker[5]!==1||worker.readUInt16LE(16)!==3||worker.readUInt16LE(18)!==40)throw new Error('NATIVE_WORKER_ELF');
 const programOffset=worker.readUInt32LE(28),entrySize=worker.readUInt16LE(42),count=worker.readUInt16LE(44);let interpreter;
 for(let i=0;i<count;i++){const start=programOffset+i*entrySize;if(worker.readUInt32LE(start)===3){const offset=worker.readUInt32LE(start+4),size=worker.readUInt32LE(start+16);interpreter=worker.subarray(offset,offset+size).toString().replace(/\0+$/,'');}}
 if(interpreter!=='./linker'||/5059|5567|worker-fpe|worker-divzero|cf_cpu_diagnostic|cf_text_range/.test(source.toString()))throw new Error('NATIVE_WORKER_PRIVATE_OR_DIAGNOSTIC');
 const sections=[],sectionOffset=worker.readUInt32LE(32),sectionSize=worker.readUInt16LE(46),sectionCount=worker.readUInt16LE(48);
 for(let i=0;i<sectionCount;i++){const start=sectionOffset+i*sectionSize;sections.push({type:worker.readUInt32LE(start+4),offset:worker.readUInt32LE(start+16),size:worker.readUInt32LE(start+20),link:worker.readUInt32LE(start+24),entrySize:worker.readUInt32LE(start+36)});}
 const string=(section,offset)=>{const start=section.offset+offset,end=worker.indexOf(0,start);if(end<start||end>=section.offset+section.size)throw new Error('NATIVE_ELF_STRING');return worker.subarray(start,end).toString();};
 const dynamic=sections.find(s=>s.type===6),symbols=sections.find(s=>s.type===11),dependencies=[],exports=[];
 if(!dynamic||!symbols)throw new Error('NATIVE_ELF_DYNAMIC');
 for(let offset=dynamic.offset;offset<dynamic.offset+dynamic.size;offset+=8)if(worker.readUInt32LE(offset)===1)dependencies.push(string(sections[dynamic.link],worker.readUInt32LE(offset+4)));
 for(let offset=symbols.offset;offset<symbols.offset+symbols.size;offset+=symbols.entrySize)if(worker.readUInt16LE(offset+14)!==0)exports.push(string(sections[symbols.link],worker.readUInt32LE(offset)));
 if(JSON.stringify(dependencies)!==JSON.stringify(['libc.so','libdl.so'])||!['bind','listen','__android_log_print','__android_log_write'].every(name=>exports.includes(name))||exports.some(name=>['__aeabi_idiv0','__aeabi_ldiv0'].includes(name)))throw new Error('NATIVE_ELF_IMPORT_EXPORT');
 if(!source.includes(Buffer.from('tighten_limit(0,3600)'))||!source.includes(Buffer.from('owner==0'))||!source.includes(Buffer.from('elapsed<21600000')))throw new Error('NATIVE_WORKER_CONTRACT');
 const manifest={format:'cloudframe.native-worker.v1',name:'p2p-connect-worker',size:worker.length,sha256:hash(worker),sourceSha256:hash(source),headerSha256:hash(header),protocol:'CFUGW002',budgets:{cpuSeconds:3600,wallMs:21600000,addressSpaceBytes:268435456,outputBytes:65536,coreBytes:0,fileSizeBytes:0,selectionMs:10000,proofBytes:4096,stopGraceMs:1000},productionLifetimeApproved:true,physicalProductionValidation:false};
 if(record)await writeFile(join(root,'native/worker-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
 else{const actual=JSON.parse(await readFile(join(root,'native/worker-manifest.json'),'utf8'));if(JSON.stringify(actual)!==JSON.stringify(manifest))throw new Error('NATIVE_WORKER_MANIFEST_MISMATCH');}
 return{...manifest,interpreter,dependencies,guardExports:exports.filter(n=>['bind','listen','__android_log_print','__android_log_write'].includes(n)),networkExecuted:false};
}
if(process.argv[1]&&resolve(process.argv[1])===join(root,'tools/audit-native-worker.mjs')){
 if(process.argv.slice(2).some(x=>x!=='--record'))throw new Error('NATIVE_AUDIT_OPTIONS');
 console.log(JSON.stringify(await auditNativeWorker({record:process.argv.includes('--record')})));
}
